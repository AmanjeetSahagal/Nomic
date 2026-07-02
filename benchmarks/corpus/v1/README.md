# Benchmark corpus v1

`schema.json` defines the reproducible corpus contract. Repository commits and patch-derived labels must be pinned; repository-level splits prevent train/test leakage.

The checked-in repository does not fabricate public benchmark claims. Populate `manifest.json` with reviewed public patches, then run the corpus runner added in a subsequent data-collection milestone. The built-in synthetic benchmark remains a smoke test only.
