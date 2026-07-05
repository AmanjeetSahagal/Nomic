#include "nomic/index.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <memory>
#include <numeric>
#include <stdexcept>
#include <unordered_set>
#include <sqlite3.h>

namespace nomic {
namespace {

constexpr double kBm25K1 = 1.2;
constexpr double kBm25B = 0.75;

bool ignored_directory(std::string_view name) {
  static const std::unordered_set<std::string> ignored = {
      ".git", ".nomic", ".next", ".turbo", "build", "coverage", "dist", "node_modules"};
  return ignored.contains(std::string{name});
}

bool allowed_file(const std::filesystem::path& path, const IndexOptions& options) {
  const auto extension = path.extension().string();
  return std::find(options.extensions.begin(), options.extensions.end(), extension) != options.extensions.end() ||
         path.filename() == "Dockerfile";
}

std::string read_text(const std::filesystem::path& path) {
  std::ifstream stream(path, std::ios::binary);
  if (!stream) {
    throw std::runtime_error("Unable to open " + path.string());
  }
  return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}

void sql_exec(sqlite3* database, const char* statement) {
  char* error = nullptr;
  if (sqlite3_exec(database, statement, nullptr, nullptr, &error) != SQLITE_OK) {
    const std::string message = error == nullptr ? "SQLite operation failed" : error;
    sqlite3_free(error);
    throw std::runtime_error(message);
  }
}

class Statement {
 public:
  Statement(sqlite3* database, const char* sql) {
    if (sqlite3_prepare_v2(database, sql, -1, &value_, nullptr) != SQLITE_OK) {
      throw std::runtime_error(sqlite3_errmsg(database));
    }
  }
  ~Statement() { sqlite3_finalize(value_); }
  Statement(const Statement&) = delete;
  Statement& operator=(const Statement&) = delete;
  sqlite3_stmt* get() const { return value_; }
  void execute() {
    if (sqlite3_step(value_) != SQLITE_DONE) {
      throw std::runtime_error("SQLite statement failed");
    }
    sqlite3_reset(value_);
    sqlite3_clear_bindings(value_);
  }
 private:
  sqlite3_stmt* value_ = nullptr;
};

}  // namespace

IndexStats Index::open(const std::filesystem::path& repository_root,
                       const IndexOptions& options) {
  close();
  repository_root_ = std::filesystem::weakly_canonical(repository_root);
  const auto* configured_index_directory = std::getenv("NOMIC_NATIVE_INDEX_DIR");
  index_directory_ = configured_index_directory != nullptr && *configured_index_directory != '\0'
      ? std::filesystem::path{configured_index_directory}
      : repository_root_ / ".nomic";
  IndexStats stats;

  std::error_code error;
  std::filesystem::recursive_directory_iterator iterator(
      repository_root_, std::filesystem::directory_options::skip_permission_denied, error);
  const std::filesystem::recursive_directory_iterator end;
  while (iterator != end) {
    if (error) {
      ++stats.failed_files;
      error.clear();
      iterator.increment(error);
      continue;
    }

    const auto& entry = *iterator;
    if (entry.is_directory(error)) {
      if (ignored_directory(entry.path().filename().string()) || entry.is_symlink(error)) {
        iterator.disable_recursion_pending();
      }
      iterator.increment(error);
      continue;
    }
    if (!entry.is_regular_file(error)) {
      iterator.increment(error);
      continue;
    }

    ++stats.discovered_files;
    const auto size = entry.file_size(error);
    if (error || size > options.maximum_file_size || !allowed_file(entry.path(), options)) {
      ++stats.skipped_files;
      error.clear();
      iterator.increment(error);
      continue;
    }

    try {
      const auto relative = std::filesystem::relative(entry.path(), repository_root_).generic_string();
      const auto content = read_text(entry.path());
      const auto terms = tokenize(content);
      Document document;
      document.id = stable_file_id(relative);
      document.path = relative;
      document.length = terms.size();
      document.content_hash = stable_file_id(content);
      for (const auto& term : terms) {
        ++document.frequencies[term];
      }
      for (const auto& [term, count] : document.frequencies) {
        static_cast<void>(count);
        ++document_frequencies_[term];
      }
      stats.indexed_terms += terms.size();
      documents_.push_back(std::move(document));
      ++stats.indexed_files;
    } catch (const std::exception&) {
      ++stats.failed_files;
    }
    iterator.increment(error);
  }

  const auto total_length = std::accumulate(
      documents_.begin(), documents_.end(), std::size_t{0},
      [](std::size_t total, const Document& document) { return total + document.length; });
  average_document_length_ = documents_.empty()
                                 ? 0.0
                                 : static_cast<double>(total_length) / static_cast<double>(documents_.size());
  persist();
  const auto database_path = index_directory_ / "index.sqlite";
  stats.index_bytes = std::filesystem::file_size(database_path, error);
  return stats;
}

std::vector<SearchResult> Index::search(std::string_view query, std::size_t limit) const {
  const auto query_terms = tokenize(query);
  std::vector<SearchResult> results;
  results.reserve(documents_.size());

  for (const auto& document : documents_) {
    double score = 0.0;
    for (const auto& term : query_terms) {
      const auto frequency = document.frequencies.find(term);
      if (frequency == document.frequencies.end()) {
        continue;
      }
      const auto document_frequency = document_frequencies_.at(term);
      const auto idf = std::log(1.0 +
          (static_cast<double>(documents_.size()) - static_cast<double>(document_frequency) + 0.5) /
          (static_cast<double>(document_frequency) + 0.5));
      const auto tf = static_cast<double>(frequency->second);
      const auto length_normalization = average_document_length_ == 0.0
          ? 1.0
          : 1.0 - kBm25B + kBm25B * static_cast<double>(document.length) / average_document_length_;
      score += idf * (tf * (kBm25K1 + 1.0)) / (tf + kBm25K1 * length_normalization);
    }
    if (score > 0.0) {
      results.push_back({document.id, document.path, score});
    }
  }

  std::sort(results.begin(), results.end(), [](const SearchResult& left, const SearchResult& right) {
    return left.lexical_score != right.lexical_score
               ? left.lexical_score > right.lexical_score
               : left.path < right.path;
  });
  if (results.size() > limit) {
    results.resize(limit);
  }
  return results;
}

void Index::close() {
  repository_root_.clear();
  index_directory_.clear();
  documents_.clear();
  document_frequencies_.clear();
  average_document_length_ = 0.0;
}

const std::filesystem::path& Index::repository_root() const noexcept { return repository_root_; }

void Index::persist() const {
  const auto directory = index_directory_.empty() ? repository_root_ / ".nomic" : index_directory_;
  std::filesystem::create_directories(directory);
  sqlite3* raw_database = nullptr;
  if (sqlite3_open((directory / "index.sqlite").string().c_str(), &raw_database) != SQLITE_OK) {
    const std::string message = raw_database == nullptr ? "Unable to open SQLite index" : sqlite3_errmsg(raw_database);
    if (raw_database != nullptr) sqlite3_close(raw_database);
    throw std::runtime_error(message);
  }
  const auto close_database = [](sqlite3* database) { sqlite3_close(database); };
  std::unique_ptr<sqlite3, decltype(close_database)> database(raw_database, close_database);

  sql_exec(database.get(), "PRAGMA journal_mode=WAL;");
  sql_exec(database.get(), "PRAGMA foreign_keys=ON;");
  sql_exec(database.get(),
      "CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);"
      "CREATE TABLE IF NOT EXISTS files(file_id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, content_hash TEXT NOT NULL, token_count INTEGER NOT NULL);"
      "CREATE TABLE IF NOT EXISTS terms(term TEXT PRIMARY KEY, document_frequency INTEGER NOT NULL);"
      "CREATE TABLE IF NOT EXISTS postings(term TEXT NOT NULL, file_id TEXT NOT NULL, frequency INTEGER NOT NULL, PRIMARY KEY(term,file_id), FOREIGN KEY(file_id) REFERENCES files(file_id) ON DELETE CASCADE);"
      "CREATE INDEX IF NOT EXISTS postings_file_idx ON postings(file_id);");
  sql_exec(database.get(), "BEGIN IMMEDIATE; DELETE FROM postings; DELETE FROM terms; DELETE FROM files;");
  try {
    Statement metadata(database.get(), "INSERT OR REPLACE INTO metadata(key,value) VALUES(?1,?2)");
    sqlite3_bind_text(metadata.get(), 1, "schema_version", -1, SQLITE_STATIC);
    const auto schema = std::to_string(kSchemaVersion);
    sqlite3_bind_text(metadata.get(), 2, schema.c_str(), -1, SQLITE_TRANSIENT);
    metadata.execute();

    Statement file_statement(database.get(), "INSERT INTO files(file_id,path,content_hash,token_count) VALUES(?1,?2,?3,?4)");
    Statement posting_statement(database.get(), "INSERT INTO postings(term,file_id,frequency) VALUES(?1,?2,?3)");
    for (const auto& document : documents_) {
      const auto id = std::to_string(document.id);
      const auto content_hash = std::to_string(document.content_hash);
      sqlite3_bind_text(file_statement.get(), 1, id.c_str(), -1, SQLITE_TRANSIENT);
      sqlite3_bind_text(file_statement.get(), 2, document.path.c_str(), -1, SQLITE_TRANSIENT);
      sqlite3_bind_text(file_statement.get(), 3, content_hash.c_str(), -1, SQLITE_TRANSIENT);
      sqlite3_bind_int64(file_statement.get(), 4, static_cast<sqlite3_int64>(document.length));
      file_statement.execute();

      for (const auto& [term, frequency] : document.frequencies) {
        sqlite3_bind_text(posting_statement.get(), 1, term.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(posting_statement.get(), 2, id.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_int64(posting_statement.get(), 3, static_cast<sqlite3_int64>(frequency));
        posting_statement.execute();
      }
    }
    Statement term_statement(database.get(), "INSERT INTO terms(term,document_frequency) VALUES(?1,?2)");
    for (const auto& [term, frequency] : document_frequencies_) {
      sqlite3_bind_text(term_statement.get(), 1, term.c_str(), -1, SQLITE_TRANSIENT);
      sqlite3_bind_int64(term_statement.get(), 2, static_cast<sqlite3_int64>(frequency));
      term_statement.execute();
    }
    sql_exec(database.get(), "COMMIT;");
  } catch (...) {
    sqlite3_exec(database.get(), "ROLLBACK;", nullptr, nullptr, nullptr);
    throw;
  }
}

std::uint64_t stable_file_id(std::string_view path) {
  std::uint64_t hash = 14695981039346656037ULL;
  for (const unsigned char value : path) {
    hash ^= value;
    hash *= 1099511628211ULL;
  }
  return hash;
}

std::vector<std::string> tokenize(std::string_view text) {
  std::vector<std::string> terms;
  std::string current;
  for (const unsigned char value : text) {
    if (std::isalnum(value) || value == '_') {
      current.push_back(static_cast<char>(std::tolower(value)));
    } else if (current.size() >= 2) {
      terms.push_back(std::move(current));
      current.clear();
    } else {
      current.clear();
    }
  }
  if (current.size() >= 2) {
    terms.push_back(std::move(current));
  }
  return terms;
}

}  // namespace nomic
