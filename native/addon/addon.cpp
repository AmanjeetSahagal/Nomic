#include <node_api.h>

#include <algorithm>
#include <exception>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "nomic/index.hpp"

namespace {

nomic::Index g_index;
std::mutex g_index_mutex;

struct Work {
  enum class Operation { Open, Search } operation;
  napi_env env = nullptr;
  napi_async_work async_work = nullptr;
  napi_deferred deferred = nullptr;
  std::string input;
  std::size_t limit = 50;
  nomic::IndexStats stats;
  std::vector<nomic::SearchResult> results;
  std::string error;
};

void check(napi_env env, napi_status status, const char* message) {
  if (status != napi_ok) {
    napi_throw_error(env, nullptr, message);
  }
}

std::string string_argument(napi_env env, napi_value value) {
  std::size_t length = 0;
  check(env, napi_get_value_string_utf8(env, value, nullptr, 0, &length), "Expected a string argument");
  std::string result(length, '\0');
  check(env, napi_get_value_string_utf8(env, value, result.data(), result.size() + 1, &length),
        "Unable to read string argument");
  return result;
}

napi_value number(napi_env env, double value) {
  napi_value result;
  check(env, napi_create_double(env, value, &result), "Unable to create number");
  return result;
}

napi_value text(napi_env env, const std::string& value) {
  napi_value result;
  check(env, napi_create_string_utf8(env, value.c_str(), value.size(), &result), "Unable to create string");
  return result;
}

void set(napi_env env, napi_value object, const char* name, napi_value value) {
  check(env, napi_set_named_property(env, object, name, value), "Unable to set result property");
}

void execute(napi_env, void* data) {
  auto* work = static_cast<Work*>(data);
  try {
    std::scoped_lock lock(g_index_mutex);
    if (work->operation == Work::Operation::Open) {
      work->stats = g_index.open(work->input);
    } else {
      work->results = g_index.search(work->input, work->limit);
    }
  } catch (const std::exception& error) {
    work->error = error.what();
  }
}

void complete(napi_env env, napi_status status, void* data) {
  std::unique_ptr<Work> work(static_cast<Work*>(data));
  if (status != napi_ok || !work->error.empty()) {
    napi_value error;
    const auto message = work->error.empty() ? "Native work was cancelled" : work->error;
    napi_create_error(env, nullptr, text(env, message), &error);
    napi_reject_deferred(env, work->deferred, error);
  } else if (work->operation == Work::Operation::Open) {
    napi_value result;
    napi_create_object(env, &result);
    set(env, result, "discoveredFiles", number(env, work->stats.discovered_files));
    set(env, result, "indexedFiles", number(env, work->stats.indexed_files));
    set(env, result, "skippedFiles", number(env, work->stats.skipped_files));
    set(env, result, "failedFiles", number(env, work->stats.failed_files));
    set(env, result, "indexedTerms", number(env, work->stats.indexed_terms));
    set(env, result, "indexBytes", number(env, static_cast<double>(work->stats.index_bytes)));
    set(env, result, "schemaVersion", number(env, work->stats.schema_version));
    napi_resolve_deferred(env, work->deferred, result);
  } else {
    napi_value result;
    napi_create_array_with_length(env, work->results.size(), &result);
    for (std::size_t index = 0; index < work->results.size(); ++index) {
      napi_value item;
      napi_create_object(env, &item);
      set(env, item, "fileId", text(env, std::to_string(work->results[index].file_id)));
      set(env, item, "path", text(env, work->results[index].path));
      set(env, item, "lexicalScore", number(env, work->results[index].lexical_score));
      napi_set_element(env, result, index, item);
    }
    napi_resolve_deferred(env, work->deferred, result);
  }
  napi_delete_async_work(env, work->async_work);
}

napi_value schedule(napi_env env, Work::Operation operation, std::string input, std::size_t limit = 50) {
  auto work = std::make_unique<Work>();
  work->operation = operation;
  work->env = env;
  work->input = std::move(input);
  work->limit = limit;
  napi_value promise;
  check(env, napi_create_promise(env, &work->deferred, &promise), "Unable to create promise");
  napi_value resource_name = text(env, operation == Work::Operation::Open ? "nomic:index" : "nomic:search");
  check(env, napi_create_async_work(env, nullptr, resource_name, execute, complete, work.get(), &work->async_work),
        "Unable to create async work");
  check(env, napi_queue_async_work(env, work->async_work), "Unable to queue async work");
  work.release();
  return promise;
}

napi_value open_repository(napi_env env, napi_callback_info info) {
  std::size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "openRepository requires a repository path");
    return nullptr;
  }
  return schedule(env, Work::Operation::Open, string_argument(env, args[0]));
}

napi_value search(napi_env env, napi_callback_info info) {
  std::size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "search requires a query");
    return nullptr;
  }
  std::uint32_t limit = 50;
  if (argc > 1) {
    napi_get_value_uint32(env, args[1], &limit);
  }
  return schedule(env, Work::Operation::Search, string_argument(env, args[0]), limit);
}

napi_value update_files(napi_env env, napi_callback_info) {
  std::string root;
  {
    std::scoped_lock lock(g_index_mutex);
    root = g_index.repository_root().string();
  }
  if (root.empty()) {
    napi_throw_error(env, nullptr, "Open a repository before updating files");
    return nullptr;
  }
  return schedule(env, Work::Operation::Open, root);
}

napi_value get_dependencies(napi_env env, napi_callback_info) {
  napi_value dependencies;
  napi_create_array(env, &dependencies);
  napi_value promise;
  napi_deferred deferred;
  napi_create_promise(env, &deferred, &promise);
  napi_resolve_deferred(env, deferred, dependencies);
  return promise;
}

napi_value close_repository(napi_env env, napi_callback_info) {
  {
    std::scoped_lock lock(g_index_mutex);
    g_index.close();
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  napi_value promise;
  napi_deferred deferred;
  napi_create_promise(env, &deferred, &promise);
  napi_resolve_deferred(env, deferred, undefined);
  return promise;
}

napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor descriptors[] = {
      {"openRepository", nullptr, open_repository, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"updateFiles", nullptr, update_files, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"search", nullptr, search, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"getDependencies", nullptr, get_dependencies, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"closeRepository", nullptr, close_repository, nullptr, nullptr, nullptr, napi_default, nullptr}};
  napi_define_properties(env, exports, std::size(descriptors), descriptors);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
