#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace nomic {

inline constexpr std::uint32_t kSchemaVersion = 1;

struct IndexOptions {
  std::size_t maximum_file_size = 1U << 20U;
  std::vector<std::string> extensions = {
      ".c", ".cc", ".cpp", ".h", ".hpp", ".js", ".jsx", ".mjs",
      ".ts", ".tsx", ".py", ".md", ".json", ".yaml", ".yml"};
};

struct IndexStats {
  std::size_t discovered_files = 0;
  std::size_t indexed_files = 0;
  std::size_t skipped_files = 0;
  std::size_t failed_files = 0;
  std::size_t indexed_terms = 0;
  std::uintmax_t index_bytes = 0;
  std::uint32_t schema_version = kSchemaVersion;
};

struct SearchResult {
  std::uint64_t file_id = 0;
  std::string path;
  double lexical_score = 0.0;
};

class Index {
 public:
  IndexStats open(const std::filesystem::path& repository_root,
                  const IndexOptions& options = {});
  std::vector<SearchResult> search(std::string_view query,
                                   std::size_t limit = 50) const;
  void close();
  [[nodiscard]] const std::filesystem::path& repository_root() const noexcept;

 private:
  struct Document {
    std::uint64_t id = 0;
    std::string path;
    std::size_t length = 0;
    std::uint64_t content_hash = 0;
    std::unordered_map<std::string, std::size_t> frequencies;
  };

  std::filesystem::path repository_root_;
  std::vector<Document> documents_;
  std::unordered_map<std::string, std::size_t> document_frequencies_;
  double average_document_length_ = 0.0;
  void persist() const;
};

std::uint64_t stable_file_id(std::string_view normalized_relative_path);
std::vector<std::string> tokenize(std::string_view text);

}  // namespace nomic
