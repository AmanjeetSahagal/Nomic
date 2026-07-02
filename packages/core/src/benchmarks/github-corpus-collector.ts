import type {
  CorpusCollectionDraft,
  CorpusRepository,
  CorpusSplit,
  CorpusTask,
  RejectedCorpusCandidate,
  TaskType
} from "./corpus-contracts";

const COLLECTOR_VERSION = "github-v1";
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".c", ".cc", ".cpp", ".cxx", ".h", ".hpp"]);
const REJECTED_LABELS = /security|dependencies|translation|localization|release|chore/i;
const REJECTED_PATHS = /(^|\/)(node_modules|vendor|third_party|generated|dist|build|locale)(\/|$)|package-lock\.json$|\.snap$/i;

interface GitHubPullRequest {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  merged_at: string | null;
  merge_commit_sha: string | null;
  labels: Array<{ name: string }>;
}

interface GitHubIssue {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  created_at: string;
  labels: Array<{ name: string }>;
  pull_request?: unknown;
}

interface GitHubFile { filename: string; status: string; additions: number; deletions: number; patch?: string }
interface GitHubCommit { sha: string; parents: Array<{ sha: string }> }

export interface CollectOptions {
  repository: CorpusRepository;
  retainLimit: number;
  scanLimit?: number;
  through?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  now?: Date;
}

export async function collectGitHubCorpus(options: CollectOptions): Promise<CorpusCollectionDraft> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const collectedAt = (options.now ?? new Date()).toISOString();
  const scanLimit = options.scanLimit ?? Math.max(100, options.retainLimit * 10);
  const through = new Date(options.through ?? "2025-12-31T23:59:59Z");
  const pulls = await listMergedPullRequests(options.repository.id, scanLimit, through, options.token, fetchImpl);
  const tasks: CorpusTask[] = [];
  const rejected: RejectedCorpusCandidate[] = [];

  for (const pull of pulls) {
    if (tasks.length >= options.retainLimit) break;
    const basicReasons = prefilterPull(pull, through);
    if (basicReasons.length > 0) {
      rejected.push(rejection(pull, basicReasons));
      continue;
    }

    const issueNumber = extractLinkedIssueNumber(`${pull.title}\n${pull.body ?? ""}`);
    if (!issueNumber) {
      rejected.push(rejection(pull, ["no explicit issue linkage"]));
      continue;
    }

    try {
      const [issue, files, commit] = await Promise.all([
        loadIssue(options.repository, pull, issueNumber, options.token, fetchImpl),
        listPullFiles(options.repository.id, pull.number, options.token, fetchImpl),
        githubGet<GitHubCommit>(`/repos/${options.repository.id}/commits/${pull.merge_commit_sha}`, options.token, fetchImpl)
      ]);
      const evaluated = buildTask(options.repository, pull, issue, files, commit, collectedAt);
      if ("reasons" in evaluated) {
        rejected.push(rejection(pull, evaluated.reasons));
      } else {
        tasks.push(evaluated.task);
      }
    } catch (error: unknown) {
      rejected.push(rejection(pull, [`collection error: ${error instanceof Error ? error.message : String(error)}`]));
    }
  }

  return { schemaVersion: 1, repository: options.repository, collectedAt, tasks, rejected };
}

export function buildTask(
  repository: CorpusRepository,
  pull: GitHubPullRequest,
  issue: GitHubIssue,
  files: GitHubFile[],
  commit: GitHubCommit,
  collectedAt: string
): { task: CorpusTask } | { reasons: string[] } {
  const reasons: string[] = [];
  if (issue.pull_request) reasons.push("linked item is a pull request, not an issue");
  if (!pull.merged_at || new Date(issue.created_at) >= new Date(pull.merged_at)) reasons.push("issue does not predate fix");
  if (REJECTED_LABELS.test([...pull.labels, ...issue.labels].map((label) => label.name).join(" "))) reasons.push("excluded label");
  if (/\b(?:security|CVE-\d{4})\b/i.test(`${issue.title} ${issue.body ?? ""}`)) reasons.push("security-sensitive task");
  const query = buildPreFixQuery(issue);
  if (query.length < 40) reasons.push("issue context is too short");
  const touched = files.filter((file) => file.status !== "removed").map((file) => file.filename);
  const sourceFiles = touched.filter((file) => isProductionSource(file, repository));
  const testFiles = touched.filter(isTestPath);
  if (sourceFiles.length === 0) reasons.push("no production source file changed");
  if (sourceFiles.length > 15) reasons.push("more than 15 production files changed");
  if (testFiles.length === 0) reasons.push("no regression test or validation file changed");
  if (touched.length === 0 || touched.every((file) => isExcludedPath(file, repository))) reasons.push("patch is generated, excluded, or non-product only");
  if (commit.parents.length === 0) reasons.push("patch commit has no reconstructable parent");
  const changedLines = files.reduce((total, file) => total + file.additions + file.deletions, 0);
  if (changedLines > 2500) reasons.push("patch exceeds 2500 changed lines");
  if (reasons.length > 0) return { reasons };

  const mergedAt = pull.merged_at as string;
  const task: CorpusTask = {
    id: `${repository.id.replace("/", "-")}-issue-${issue.number}-pr-${pull.number}`,
    repositoryId: repository.id,
    baseCommit: commit.parents[0]?.sha ?? "",
    patchCommit: commit.sha,
    pullRequest: { number: pull.number, url: pull.html_url, mergedAt },
    issue: {
      number: issue.number,
      url: issue.html_url,
      title: issue.title,
      body: issue.body ?? "",
      createdAt: issue.created_at
    },
    query,
    taskType: inferTaskType(issue),
    relevance: {
      primaryFiles: unique(sourceFiles),
      supportingFiles: unique(touched.filter((file) => !sourceFiles.includes(file) && !isExcludedPath(file, repository))),
      relevantUnchangedFiles: [],
      symbols: []
    },
    patchTouchedFiles: unique(touched),
    labels: unique([...issue.labels, ...pull.labels].map((label) => label.name)),
    split: temporalSplit(mergedAt),
    review: { status: "draft" },
    provenance: { collectorVersion: COLLECTOR_VERSION, collectedAt, queryUsesPreFixEvidenceOnly: true }
  };
  return { task };
}

export function extractLinkedIssueNumber(text: string): number | null {
  const patterns = [
    /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+(?:https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/)?#?(\d+)\b/i,
    /\b(?:fixed|refs?|addresses)\s+#(\d+)\b/i
  ];
  for (const pattern of patterns) {
    const value = pattern.exec(text)?.[1];
    if (value) return Number(value);
  }
  return null;
}

export function temporalSplit(mergedAt: string): CorpusSplit {
  const year = new Date(mergedAt).getUTCFullYear();
  if (year < 2024) return "train";
  if (year === 2024) return "validation";
  return "test";
}

export function parseDjangoTracTicket(html: string, issueNumber: number, mergedAt: string): GitHubIssue {
  const valuesText = /var old_values=(\{[^]*?\});\s*var changes=/.exec(html)?.[1];
  const changesText = /var changes=(\[[^]*?\]);\s*var auto_preview/.exec(html)?.[1];
  if (!valuesText || !changesText) throw new Error(`Unable to parse Django Trac ticket #${issueNumber}`);
  const values = JSON.parse(valuesText) as Record<string, unknown>;
  const changes = JSON.parse(changesText) as Array<{ date?: number; fields?: Record<string, { old?: unknown }> }>;
  const cutoffMicros = new Date(mergedAt).getTime() * 1000;
  for (const change of [...changes].sort((left, right) => (right.date ?? 0) - (left.date ?? 0))) {
    if ((change.date ?? 0) <= cutoffMicros) continue;
    for (const field of ["summary", "description"] as const) {
      if (change.fields?.[field] && "old" in change.fields[field]) values[field] = change.fields[field].old ?? "";
    }
  }
  const title = typeof values.summary === "string" ? values.summary : "";
  const body = typeof values.description === "string" ? values.description : "";
  const createdAt = typeof values.time === "string" ? values.time : "";
  if (!title || !body || Number.isNaN(new Date(createdAt).getTime())) throw new Error(`Django Trac ticket #${issueNumber} lacks required pre-fix fields`);
  const labels = [values.type, values.component].filter((value): value is string => typeof value === "string" && value.length > 0).map((name) => ({ name }));
  return {
    number: issueNumber,
    html_url: `https://code.djangoproject.com/ticket/${issueNumber}`,
    title,
    body,
    created_at: createdAt,
    labels
  };
}

function buildPreFixQuery(issue: GitHubIssue): string {
  const body = (issue.body ?? "").replace(/<!--[^]*?-->/g, " ").replace(/\s+/g, " ").trim();
  return `${issue.title.trim()}\n\n${body}`.trim().slice(0, 8000);
}

function inferTaskType(issue: GitHubIssue): TaskType {
  const text = `${issue.title} ${issue.body ?? ""}`.toLowerCase();
  if (/\b(add|support|feature|proposal|request)\b/.test(text)) return "feature-location";
  return /\b(bug|error|incorrect|fails?|regression|crash|broken)\b/.test(text)
    ? "bug-localization"
    : "repository-navigation";
}

function prefilterPull(pull: GitHubPullRequest, through: Date): string[] {
  const reasons: string[] = [];
  if (!pull.merged_at || !pull.merge_commit_sha) reasons.push("pull request is not merged");
  if (pull.merged_at && new Date(pull.merged_at) > through) reasons.push("fix is newer than corpus cutoff");
  if (/\b(dependabot|renovate|release|chore|format(?:ting)?|localization|translation|revert)\b/i.test(pull.title)) {
    reasons.push("automated, release, formatting, or localization change");
  }
  return reasons;
}

function isProductionSource(file: string, repository: CorpusRepository): boolean {
  const extension = file.slice(file.lastIndexOf(".")).toLowerCase();
  return SOURCE_EXTENSIONS.has(extension) && !isTestPath(file) && !isExcludedPath(file, repository) &&
    (!repository.scopePaths?.length || repository.scopePaths.some((prefix) => file.startsWith(prefix)));
}

function isTestPath(file: string): boolean {
  return /(^|\/)(test|tests|testing)(\/|$)|(?:\.|_)(?:test|spec)\.[^.]+$|\/test_[^/]+\.py$/i.test(file);
}

function isExcludedPath(file: string, repository: CorpusRepository): boolean {
  return REJECTED_PATHS.test(file) || repository.excludedPaths.some((pattern) => globMatch(file, pattern));
}

function globMatch(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}`).test(value);
}

async function listMergedPullRequests(repository: string, limit: number, through: Date, token: string | undefined, fetchImpl: typeof fetch): Promise<GitHubPullRequest[]> {
  const pulls: GitHubPullRequest[] = [];
  for (let page = 1; pulls.length < limit && page <= 100; page += 1) {
    const pageResults = await githubGet<GitHubPullRequest[]>(`/repos/${repository}/pulls?state=closed&sort=created&direction=desc&per_page=100&page=${page}`, token, fetchImpl);
    pulls.push(...pageResults.filter((pull) => pull.merged_at && pull.merge_commit_sha && new Date(pull.merged_at) <= through));
    if (pageResults.length < 100) break;
  }
  return pulls.slice(0, limit);
}

async function loadIssue(repository: CorpusRepository, pull: GitHubPullRequest, issueNumber: number, token: string | undefined, fetchImpl: typeof fetch): Promise<GitHubIssue> {
  if (repository.id === "django/django") {
    const response = await fetchImpl(`https://code.djangoproject.com/ticket/${issueNumber}`, { headers: { "User-Agent": "nomic-corpus-collector" } });
    if (!response.ok) throw new Error(`Django Trac ${response.status} for ticket #${issueNumber}`);
    return parseDjangoTracTicket(await response.text(), issueNumber, pull.merged_at as string);
  }
  return githubGet<GitHubIssue>(`/repos/${repository.id}/issues/${issueNumber}`, token, fetchImpl);
}

async function listPullFiles(repository: string, pullNumber: number, token: string | undefined, fetchImpl: typeof fetch): Promise<GitHubFile[]> {
  const files: GitHubFile[] = [];
  for (let page = 1; page <= 4; page += 1) {
    const pageResults = await githubGet<GitHubFile[]>(`/repos/${repository}/pulls/${pullNumber}/files?per_page=100&page=${page}`, token, fetchImpl);
    files.push(...pageResults);
    if (pageResults.length < 100) break;
  }
  return files;
}

async function githubGet<T>(apiPath: string, token: string | undefined, fetchImpl: typeof fetch): Promise<T> {
  const response = await fetchImpl(`https://api.github.com${apiPath}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "nomic-corpus-collector",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  });
  if (!response.ok) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    throw new Error(`GitHub API ${response.status} for ${apiPath}${remaining === "0" ? " (rate limit exhausted)" : ""}`);
  }
  return response.json() as Promise<T>;
}

function rejection(pull: GitHubPullRequest, reasons: string[]): RejectedCorpusCandidate {
  return { pullRequestNumber: pull.number, pullRequestUrl: pull.html_url, reasons };
}

function unique<T>(values: T[]): T[] { return [...new Set(values)]; }
