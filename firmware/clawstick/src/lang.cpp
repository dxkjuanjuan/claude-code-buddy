#include "lang.h"
#include "stats.h"

// String table: English first, Chinese second.
// Chinese strings use UTF-8; display requires a font with CJK glyphs.
// Without a CJK font loaded, Chinese characters will show as blocks/garbage.
// The language setting is still useful: it stores the preference so when
// a CJK font is available it activates automatically.

static const char* const _str[S_COUNT][LANG_COUNT] = {
  // --- settings.cpp ---
  [S_SETTINGS_TITLE]    = {"SETTINGS",    "\xe8\xae\xbe\xe7\xbd\xae"},       // 设置
  [S_SETTINGS_BRIGHTNESS] = {"bright",   "\xe4\xba\xae\xe5\xba\xa6"},       // 亮度
  [S_SETTINGS_SOUND]    = {"sound",       "\xe5\xa3\xb0\xe9\x9f\xb3"},       // 声音
  [S_SETTINGS_BLUETOOTH] = {"bluetooth",  "\xe8\x93\x9d\xe7\x89\x99"},       // 蓝牙
  [S_SETTINGS_LED]      = {"led",         "LED"},
  [S_SETTINGS_RESET]    = {"reset",       "\xe9\x87\x8d\xe7\xbd\xae"},       // 重置
  [S_SETTINGS_BACK]     = {"back",        "\xe8\xbf\x94\xe5\x9b\x9e"},       // 返回
  [S_SETTINGS_LANG]     = {"language",    "\xe8\xaf\xad\xe8\xa8\x80"},       // 语言
  [S_SETTINGS_ON]       = {"on",          "\xe5\xbc\x80"},
  [S_SETTINGS_OFF]      = {"off",         "\xe5\x85\xb3"},
  [S_SETTINGS_A_NEXT]   = {"A next",      "A \xe4\xb8\x8b\xe4\xb8\x80"},    // A 下一
  [S_SETTINGS_B_CHANGE] = {"B change",    "B \xe5\x88\x87\xe6\x8d\xa2"},     // B 切换

  // --- menu.cpp ---
  [S_MENU_TITLE]        = {"MENU",        "\xe8\x8f\x9c\xe5\x8d\x95"},       // 菜单
  [S_MENU_SETTINGS]     = {"settings",    "\xe8\xae\xbe\xe7\xbd\xae"},       // 设置
  [S_MENU_SLEEP]        = {"sleep now",   "\xe4\xbc\x91\xe7\x9c\xa0"},       // 休眠
  [S_MENU_ABOUT]        = {"about",       "\xe5\x85\xb3\xe4\xba\x8e"},       // 关于
  [S_MENU_POWER_OFF]    = {"power off",   "\xe5\x85\xb3\xe6\x9c\xba"},       // 关机
  [S_MENU_CLOSE]        = {"close",       "\xe5\x85\xb3\xe9\x97\xad"},       // 关闭
  [S_MENU_REALLY]       = {"really?",     "\xe7\xa1\xae\xe5\xae\x9a?"},      // 确定?
  [S_MENU_A_NEXT]       = {"A next",      "A \xe4\xb8\x8b\xe4\xb8\x80"},    // A 下一
  [S_MENU_B_SELECT]     = {"B select",    "B \xe9\x80\x89\xe6\x8b\xa9"},     // B 选择
  [S_MENU_ABOUT_TITLE]  = {"ABOUT",       "\xe5\x85\xb3\xe4\xba\x8e"},       // 关于
  [S_MENU_PRODUCT]      = {"product",     "\xe4\xba\xa7\xe5\x93\x81"},       // 产品
  [S_MENU_DEVICE]       = {"device",      "\xe8\xae\xbe\xe5\xa4\x87"},       // 设备
  [S_MENU_OWNER]        = {"owner",       "\xe4\xb8\xbb\xe4\xba\xba"},       // 主人
  [S_MENU_PET]          = {"pet",         "\xe5\xae\xa0\xe7\x89\xa9"},       // 宠物
  [S_MENU_A_BACK]       = {"A back",      "A \xe8\xbf\x94\xe5\x9b\x9e"},    // A 返回
  [S_MENU_B_BACK]       = {"B back",      "B \xe8\xbf\x94\xe5\x9b\x9e"},    // B 返回
  [S_MENU_HELP_A]       = {"Button A",    "A \xe9\x94\xae"},
  [S_MENU_HELP_B]       = {"Button B",    "B \xe9\x94\xae"},
  [S_MENU_HELP_HOLD]    = {"Hold A",      "\xe9\x95\xbf\xe6\x8c\x89""A"},     // 长按A

  // --- reset.cpp ---
  [S_RESET_TITLE]       = {"RESET",       "\xe9\x87\x8d\xe7\xbd\xae"},       // 重置
  [S_RESET_DELETE_CHAR] = {"delete char", "\xe5\x88\xa0\xe9\x99\xa4\xe8\xa7\x92\xe8\x89\xb2"}, // 删除角色
  [S_RESET_FACTORY]     = {"factory",     "\xe6\x81\xa2\xe5\xa4\x8d\xe5\x87\xba\xe5\x8e\x82"}, // 恢复出厂
  [S_RESET_BACK]        = {"back",        "\xe8\xbf\x94\xe5\x9b\x9e"},       // 返回
  [S_RESET_REALLY]      = {"really?",     "\xe7\xa1\xae\xe5\xae\x9a?"},      // 确定?
  [S_RESET_PRESS_B]     = {"press B x2",  "\xe6\x8c\x89""B\xe4\xb8\xa4\xe6\xac\xa1"}, // 按B两次
  [S_RESET_A_NEXT]      = {"A next",      "A \xe4\xb8\x8b\xe4\xb8\x80"},    // A 下一
  [S_RESET_B_CONFIRM]   = {"B confirm",   "B \xe7\xa1\xae\xe8\xae\xa4"},     // B 确认

  // --- approval.cpp ---
  [S_APPROVAL_AGENT_ASKS] = {"agent asks", "\xe4\xbb\xa3\xe7\x90\x86\xe8\xaf\xb7\xe6\xb1\x82"}, // 代理请求
  [S_APPROVAL_TOOL]     = {"TOOL",        "\xe5\xb7\xa5\xe5\x85\xb7"},       // 工具
  [S_APPROVAL_DETAIL]   = {"DETAIL",      "\xe8\xaf\xa6\xe6\x83\x85"},       // 详情
  [S_APPROVAL_A_ALLOW]  = {"A: allow",    "A: \xe5\x85\x81\xe8\xae\xb8"},   // A: 允许
  [S_APPROVAL_B_DENY]   = {"B: deny",     "B: \xe6\x8b\x92\xe7\xbb\x9d"},   // B: 拒绝
  [S_APPROVAL_SENT]     = {"sent...",     "\xe5\xb7\xb2\xe5\x8f\x91\xe9\x80\x81..."}, // 已发送...

  // --- home.cpp ---
  [S_HOME_WORKING]      = {"working",     "\xe5\xb7\xa5\xe4\xbd\x9c\xe4\xb8\xad"}, // 工作中
  [S_HOME_THINKING]     = {"thinking",    "\xe6\x80\x9d\xe8\x80\x83\xe4\xb8\xad"}, // 思考中
  [S_HOME_DIZZY]        = {"dizzy",       "\xe6\x99\x95\xe7\x9c\xa9"},       // 晕眩
  [S_HOME_ERROR]        = {"error",       "\xe9\x94\x99\xe8\xaf\xaf"},       // 错误
  [S_HOME_IDLE]         = {"idle",        "\xe7\xa9\xba\xe9\x97\xb2"},       // 空闲
  [S_HOME_NO_SESSIONS]  = {"no sessions", "\xe6\x97\xa0\xe4\xbc\x9a\xe8\xaf\x9d"}, // 无会话
  [S_HOME_1_SESSION]    = {"1 session",   "1 \xe4\xbc\x9a\xe8\xaf\x9d"},    // 1 会话
  [S_HOME_SESSIONS]     = {"sessions",    "\xe4\xbc\x9a\xe8\xaf\x9d"},       // 会话
  [S_HOME_A_NEXT]       = {"A >",         "A >"},
  [S_HOME_HOLD_A]       = {"hold A menu", "\xe9\x95\xbf\xe6\x8c\x89""A"},     // 长按A

  // --- link.cpp ---
  [S_LINK_LINKED]       = {"linked",      "\xe5\xb7\xb2\xe8\xbf\x9e\xe6\x8e\xa5"}, // 已连接
  [S_LINK_LINKING]      = {"linking",     "\xe8\xbf\x9e\xe6\x8e\xa5\xe4\xb8\xad"}, // 连接中
  [S_LINK_STANDALONE]   = {"standalone",  "\xe7\x8b\xac\xe7\xab\x8b"},       // 独立
  [S_LINK_OFF]          = {"off",         "\xe5\x85\xb3\xe9\x97\xad"},       // 关闭
  [S_LINK_CHARGING]     = {"charging",    "\xe5\x85\x85\xe7\x94\xb5\xe4\xb8\xad"}, // 充电中
  [S_LINK_ON_USB]       = {"on USB",      "USB \xe4\xbe\x9b\xe7\x94\xb5"},  // USB 供电
  [S_LINK_BATTERY]      = {"battery",     "\xe7\x94\xb5\xe6\xb1\xa0"},       // 电池
  [S_LINK_A_NEXT]       = {"A >",         "A >"},
  [S_LINK_B_RECONN]     = {"B reconn",    "B \xe9\x87\x8d\xe8\xbf\x9e"},    // B 重连

  // --- main.cpp ---
  [S_MAIN_BT_PAIRING]   = {"BT PAIRING",  "\xe8\x93\x9d\xe7\x89\x99\xe9\x85\x8d\xe5\xaf\xb9"}, // 蓝牙配对
  [S_MAIN_ENTER_ON_DESKTOP] = {"enter on desktop:", "\xe5\x9c\xa8\xe6\xa1\x8c\xe9\x9d\xa2\xe8\xbe\x93\xe5\x85\xa5:"}, // 在桌面输入:
  [S_MAIN_INSTALLING]   = {"installing",  "\xe5\xae\x89\xe8\xa3\x85\xe4\xb8\xad"}, // 安装中
};

const char* L(StrID id) {
  if (id >= S_COUNT) return "";
  return _str[id][langCurrent()];
}

const char* Lx(StrID id, LangId lang) {
  if (id >= S_COUNT || lang >= LANG_COUNT) return "";
  return _str[id][lang];
}

LangId langCurrent() {
  return static_cast<LangId>(settingsGet().lang);
}
