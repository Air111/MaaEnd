#include "zipline_preference.h"

#include <algorithm>
#include <cctype>
#include <string>
#include <utility>

#include <MaaFramework/MaaAPI.h>
#include <MaaUtils/Logger.h>
#include <meojson/json.hpp>

#include "../../Common/notice.h"
#include "../../Zipline/ZiplineStore.h"
#include "../sensing/pipeline_node_reader.h"
#include "zipline_leg_planner.h"

namespace mapnavigator
{

namespace
{

// 三态存在这个节点的 attach 里, 节点只存值不执行
constexpr const char* kPreferenceNode = "MapNavigatorZiplinePreference";
constexpr const char* kAccountIdentityNode = "CurrentAccountIdentity";
constexpr const char* kCaptureUidNode = "MapNavigatorZiplineCaptureUid";
constexpr const char* kAccountOverrideNode = "MapNavigatorZiplineAccount";
constexpr size_t kAccountIdLength = 16;

bool is_valid_account_id(const std::string& account_id)
{
    return account_id.size() == kAccountIdLength
           && std::all_of(account_id.begin(), account_id.end(), [](unsigned char ch) {
                  return std::isxdigit(ch) != 0;
              });
}

struct AccountOverride
{
    bool force_first = false;
    std::string account_id;
};

bool read_preference(MaaContext* context, bool requested)
{
    const auto node = ReadNodeObject(context, kPreferenceNode, "ZiplinePreference");
    if (!node || !node->contains("attach") || !node->at("attach").is_object()) {
        return requested;
    }
    const std::string value = node->at("attach").as_object().get("zipline", std::string {});

    if (value == "always") {
        return true;
    }
    if (value == "never") {
        return false;
    }
    // "auto" 和认不出的值都跟随请求
    return requested;
}

std::string read_account_identity(MaaContext* context)
{
    const auto node = ReadNodeObject(context, kAccountIdentityNode, "ZiplineAccount");
    if (!node || !node->contains("attach") || !node->at("attach").is_object()) {
        return {};
    }
    const std::string account_id = node->at("attach").as_object().get("account_id", std::string {});
    if (!account_id.empty() && !is_valid_account_id(account_id)) {
        LogWarn << "ZiplineAccount: identity has invalid format" << VAR(account_id.size());
        return {};
    }
    return account_id;
}

AccountOverride read_account_override(MaaContext* context)
{
    const auto node = ReadNodeObject(context, kAccountOverrideNode, "ZiplineAccount");
    if (!node || !node->contains("attach") || !node->at("attach").is_object()) {
        return {};
    }
    const auto& attach = node->at("attach").as_object();
    AccountOverride result;
    result.force_first = attach.get("force_first", false);

    const std::string account_id = attach.get("account_id", std::string {});
    if (account_id.empty()) {
        return result;
    }
    if (!is_valid_account_id(account_id)) {
        LogWarn << "ZiplineAccount: override has invalid format" << VAR(account_id.size());
        return result;
    }
    std::string normalized = account_id;
    std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });
    result.account_id = std::move(normalized);
    return result;
}

} // namespace

bool ResolveZiplineEnabled(MaaContext* context, bool requested)
{
    return read_preference(context, requested);
}

std::string ReadOrCaptureZiplineAccountId(MaaContext* context)
{
    const AccountOverride configured = read_account_override(context);
    if (configured.force_first) {
        zipline::ZiplineStore store;
        const std::filesystem::path path = zipline::ZiplineStore::DefaultPath();
        if (store.load(path)) {
            const std::string account_id = store.latestAccountId();
            if (!account_id.empty()) {
                LogInfo << "ZiplineAccount: using the first saved account as configured" << VAR(account_id);
                return account_id;
            }
        }
        LogWarn << "ZiplineAccount: force-first is enabled but no saved account is available";
    }
    if (!configured.account_id.empty()) {
        LogInfo << "ZiplineAccount: using the account configured for this task" << VAR(configured.account_id);
        return configured.account_id;
    }

    std::string account_id = read_account_identity(context);
    if (account_id.empty()) {
        if (MaaContextRunTask(context, kCaptureUidNode, "{}") == MaaInvalidId) {
            LogWarn << "ZiplineAccount: UID capture did not run." << VAR(kCaptureUidNode);
        }
        account_id = read_account_identity(context);
    }
    if (account_id.empty()) {
        LogWarn << "ZiplineAccount: current game account is unavailable; zipline records will not be used";
        return account_id;
    }

    LogInfo << "ZiplineAccount: current game account selected" << VAR(account_id);
    return account_id;
}

size_t ClaimLegacyZiplineRecords(const std::string& account_id)
{
    const std::filesystem::path path = zipline::ZiplineStore::DefaultPath();

    zipline::ZiplineStore store;
    if (!store.load(path)) {
        LogError << "ZiplineAccount: load zipline records failed, skip claiming legacy records" << VAR(path);
        return 0;
    }
    return store.claimLegacyRecords(account_id, path);
}

void NoticeClaimedLegacyZiplineRecords(MaaContext* context, size_t claimed)
{
    if (context == nullptr || claimed == 0) {
        return;
    }

    LogInfo << "ZiplineAccount: claimed legacy zipline records for the current account" << VAR(claimed);
    common::notice::Publish(context, common::notice::Text("zipline.legacy_claimed", { static_cast<int64_t>(claimed) }));
}

void NoticeZiplineOutcome(ZiplineNoticeLatch* latch, MaaContext* context, const ZiplineOutcome& outcome)
{
    if (context == nullptr) {
        return;
    }

    if (outcome.used) {
        latch->told_no_data.store(false);
        latch->told_account_unknown.store(false);
        return;
    }

    if (outcome.account_unknown) {
        if (!latch->told_account_unknown.exchange(true)) {
            LogWarn << "Zipline requested but the current game account could not be identified; this route walks the whole way.";
            common::notice::Publish(context, common::notice::Text("zipline.account_unknown"));
        }
        return;
    }
    latch->told_account_unknown.store(false);

    if (outcome.no_data && !latch->told_no_data.exchange(true)) {
        LogWarn << "Zipline requested but no zipline coordinates are available here; this route walks the whole way.";
        common::notice::Publish(context, common::notice::Text("zipline.no_data"));
    }
}

} // namespace mapnavigator
