import { describe, expect, it } from "vitest";
import type { CorpusManifest, CorpusRepository, CorpusTask } from "./corpus-contracts";
import { buildTask, extractLinkedIssueNumber, parseDjangoTracTicket, temporalSplit } from "./github-corpus-collector";
import { validateCorpus } from "./corpus-validator";

const repository: CorpusRepository = {
  id: "django/django", url: "https://github.com/django/django", languages: ["python"], stage: 1,
  difficulty: "medium-high", role: "fixture", excludedPaths: ["docs/"]
};

describe("GitHub corpus collection", () => {
  it("extracts explicit causal issue links and assigns temporal splits", () => {
    expect(extractLinkedIssueNumber("Fixed #35123 -- corrected query behavior")).toBe(35123);
    expect(extractLinkedIssueNumber("Resolves https://github.com/django/django/issues/42")).toBe(42);
    expect(extractLinkedIssueNumber("unlinked cleanup")).toBeNull();
    expect(temporalSplit("2023-01-01T00:00:00Z")).toBe("train");
    expect(temporalSplit("2024-06-01T00:00:00Z")).toBe("validation");
    expect(temporalSplit("2025-01-01T00:00:00Z")).toBe("test");
  });

  it("reconstructs Django ticket text as it existed before the fix", () => {
    const html = `<script>var old_values={"summary":"Post-fix title","description":"Post-fix description","time":"2023-01-01T00:00:00Z","type":"Bug","component":"ORM"}; var changes=[{"date":1730000000000000,"fields":{"summary":{"old":"Pre-fix title"},"description":{"old":"Pre-fix reproduction with enough meaningful context for retrieval."}}}]; var auto_preview_timeout=2;</script>`;
    const issue = parseDjangoTracTicket(html, 123, "2024-01-01T00:00:00Z");
    expect(issue.title).toBe("Pre-fix title");
    expect(issue.body).toContain("Pre-fix reproduction");
    expect(issue.html_url).toBe("https://code.djangoproject.com/ticket/123");
  });

  it("creates a graded draft using only issue text", () => {
    const result = buildTask(repository,
      { number: 10, html_url: "https://github.com/django/django/pull/10", title: "Fixed #9", body: "Fixes #9", merged_at: "2024-05-01T00:00:00Z", merge_commit_sha: "b".repeat(40), labels: [] },
      { number: 9, html_url: "https://github.com/django/django/issues/9", title: "QuerySet returns incorrect rows", body: "A filtered query returns duplicate records when ordering across a relation.", created_at: "2024-04-01T00:00:00Z", labels: [{ name: "bug" }] },
      [
        { filename: "django/db/models/query.py", status: "modified", additions: 4, deletions: 2 },
        { filename: "tests/queries/test_qs_combinators.py", status: "modified", additions: 8, deletions: 0 }
      ],
      { sha: "b".repeat(40), parents: [{ sha: "a".repeat(40) }] }, "2026-01-01T00:00:00Z");
    expect("task" in result).toBe(true);
    if ("task" in result) {
      expect(result.task.query).toContain("duplicate records");
      expect(result.task.query).not.toContain("Fixed #9");
      expect(result.task.relevance.primaryFiles).toEqual(["django/db/models/query.py"]);
      expect(result.task.relevance.supportingFiles).toEqual(["tests/queries/test_qs_combinators.py"]);
      expect(result.task.review.status).toBe("draft");
    }
  });

  it("rejects patches without a production change and regression test", () => {
    const result = buildTask(repository,
      { number: 10, html_url: "pr", title: "Fixed #9", body: "Fixes #9", merged_at: "2024-05-01T00:00:00Z", merge_commit_sha: "b".repeat(40), labels: [] },
      { number: 9, html_url: "issue", title: "Documentation typo", body: "The documentation contains enough context to describe this typo clearly.", created_at: "2024-04-01T00:00:00Z", labels: [] },
      [{ filename: "docs/topic.txt", status: "modified", additions: 1, deletions: 1 }],
      { sha: "b".repeat(40), parents: [{ sha: "a".repeat(40) }] }, "2026-01-01T00:00:00Z");
    expect("reasons" in result && result.reasons).toEqual(expect.arrayContaining(["no production source file changed", "no regression test or validation file changed"]));
  });
});

describe("corpus validation", () => {
  it("requires reviewed tasks and consistent patch-derived labels", () => {
    const task = makeTask();
    const corpus: CorpusManifest = { schemaVersion: 1, name: "fixture", repositories: [repository], tasks: [task] };
    expect(validateCorpus(corpus).errors).toEqual([]);
    task.relevance.supportingFiles.push("missing.py");
    expect(validateCorpus(corpus).errors.join("\n")).toContain("absent from patchTouchedFiles");
  });
});

function makeTask(): CorpusTask {
  return {
    id: "django-django-issue-9-pr-10", repositoryId: repository.id,
    baseCommit: "a".repeat(40), patchCommit: "b".repeat(40),
    pullRequest: { number: 10, url: "pr", mergedAt: "2024-05-01T00:00:00Z" },
    issue: { number: 9, url: "issue", title: "Incorrect query", body: "Detailed reproduction", createdAt: "2024-04-01T00:00:00Z" },
    query: "Incorrect query\n\nDetailed reproduction showing duplicate results.", taskType: "bug-localization",
    relevance: { primaryFiles: ["django/db/models/query.py"], supportingFiles: ["tests/queries/test.py"], relevantUnchangedFiles: [], symbols: [{ name: "QuerySet", path: "django/db/models/query.py", grade: 3 }] },
    patchTouchedFiles: ["django/db/models/query.py", "tests/queries/test.py"], labels: ["bug"], split: "validation",
    review: { status: "accepted", reviewedAt: "2026-01-01T00:00:00Z" },
    provenance: { collectorVersion: "fixture", collectedAt: "2026-01-01T00:00:00Z", queryUsesPreFixEvidenceOnly: true }
  };
}
