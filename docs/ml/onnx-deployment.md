# ONNX deployment

The neural exporter uses opset 17 and a dynamic candidate batch dimension. A sibling `.metadata.json` records checksum, feature schema/count, normalization, corpus, commit, metrics, and symbol safety policy. Validation compares PyTorch and ONNX for single and batch inference and rejects invalid widths or non-finite values.

Runtime ONNX loading is lazy and local. Failures—including missing files or runtime, bad checksum/metadata/schema/shape, timeout, and NaN/Infinity—preserve the frozen baseline order. MCP arguments never accept an arbitrary model path; operators configure it through the trusted server environment.
