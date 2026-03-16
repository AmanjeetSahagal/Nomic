import {
  type ContextCandidate,
  type FileSummary,
  type RepositoryIndex,
  type SummarizationProvider
} from "../types/contracts";

export class ContextCompressor {
  constructor(private readonly summarizer?: SummarizationProvider) {}

  async compress(candidates: ContextCandidate[], index: RepositoryIndex): Promise<FileSummary[]> {
    if (this.summarizer) {
      return this.summarizer.summarize(candidates, index);
    }

    return candidates.map((candidate) => ({
      path: candidate.path,
      summary: `Placeholder summary for ${candidate.path}`,
      preservedInterfaces: []
    }));
  }
}
