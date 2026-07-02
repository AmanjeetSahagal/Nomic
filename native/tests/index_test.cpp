#include "nomic/index.hpp"

#include <cassert>
#include <filesystem>
#include <fstream>

int main() {
  const auto root = std::filesystem::temp_directory_path() / "nomic-native-test";
  std::filesystem::remove_all(root);
  std::filesystem::create_directories(root / "src");
  std::ofstream(root / "src" / "auth.ts") << "export class AuthService { loginUser() {} }";
  std::ofstream(root / "src" / "misc.ts") << "export function unrelated() {}";

  nomic::Index index;
  const auto stats = index.open(root);
  assert(stats.indexed_files == 2);
  const auto results = index.search("AuthService loginUser", 10);
  assert(!results.empty());
  assert(results.front().path == "src/auth.ts");
  assert(results.front().file_id == nomic::stable_file_id("src/auth.ts"));
  assert(std::filesystem::exists(root / ".nomic" / "index.sqlite"));

  std::filesystem::remove_all(root);
  return 0;
}
