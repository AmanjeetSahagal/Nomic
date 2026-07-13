"""Deterministic feature extraction for exported BM25 candidate records."""
from __future__ import annotations
import math, re
from pathlib import PurePosixPath
from typing import Any
from ml.common import FEATURES, stable_id

def tokens(value: str) -> list[str]: return [token for token in re.split(r"[^a-z0-9_]+", value.lower()) if len(token) >= 2]
def overlap(left: list[str], right: list[str]) -> float:
    unique = set(left); return len(unique & set(right)) / len(unique) if unique else 0.0

def extract(query: str, candidate: dict[str, Any], rank: int, top_score: float, second_score: float, repository: dict[str, Any]) -> dict[str, float]:
    path = PurePosixPath(candidate["path"]); query_tokens = tokens(query); content = candidate.get("content", "")
    symbols = candidate.get("symbols", []); symbol_tokens = [token for symbol in symbols for token in tokens(symbol.get("name", ""))]
    exact = [symbol for symbol in symbols if symbol.get("name", "").lower() in query.lower()]
    comments = [line for line in content.splitlines() if re.match(r"\s*(//|#|/\*|\*)", line)]
    score = float(candidate.get("bm25Score", candidate.get("score", 0)))
    extension = path.suffix.lower(); is_test = bool(candidate.get("isTest") or re.search(r"(^|/)(tests?|__tests__)(/|$)|[._-](test|spec)\.", str(path), re.I))
    values = {
        "bm25Score": score, "normalizedBm25Score": score / max(top_score, 1e-9), "bm25Rank": rank, "topScoreMargin": top_score - second_score,
        "exactSymbolMatch": int(bool(exact)), "prefixSymbolMatch": int(any(s.get("name", "").lower().startswith(q) for s in symbols for q in query_tokens)),
        "symbolTokenOverlap": overlap(query_tokens, symbol_tokens), "matchingSymbolCount": len(exact), "symbolTypeId": stable_id((exact or symbols or [{"kind":"unknown"}])[0].get("kind", "unknown"), 17),
        "filenameOverlap": overlap(query_tokens, tokens(path.stem)), "pathTokenOverlap": overlap(query_tokens, tokens(str(path))), "directoryDepth": len(path.parts)-1, "fileExtensionId": stable_id(extension or "none"),
        "isImplementationFile": int(not is_test and extension not in {".md", ".rst", ".txt", ".adoc"}), "isTestFile": int(is_test), "isDocumentationFile": int(extension in {".md", ".rst", ".txt", ".adoc"}),
        "isGeneratedFile": int(bool(re.search(r"generated|vendor|dist|build|\.min\.", str(path), re.I))), "queryTermCoverage": overlap(query_tokens, tokens(content)),
        "rareTermMatchCount": len({q for q in query_tokens if len(q)>=8 and q in content.lower()}), "identifierOverlap": overlap([q for q in query_tokens if len(q)>=4], symbol_tokens + tokens(str(path))),
        "commentOverlap": overlap(query_tokens, tokens(" ".join(comments))), "chunkTokenCount": float(candidate.get("chunkTokenCount", max(1, len(content)//4))),
        "symbolLineCount": sum(max(0, int(s.get("endLine",0))-int(s.get("startLine",0))+1) for s in exact), "codeToCommentRatio": (len(content.splitlines())-len(comments))/max(1,len(comments)),
        "repositoryLanguageId": stable_id(repository.get("language", candidate.get("language", "unknown"))), "repositoryFileCountBucket": min(10, int(math.log2(max(1, repository.get("fileCount",1))))),
        "inboundDependencyCount": float(candidate.get("inboundDependencyCount",0)), "dependencyDistance": float(candidate.get("dependencyDistance",0)),
    }
    return {name: float(values.get(name, 0)) for name in FEATURES}
