#pragma once
#include <stdint.h>
#include <string.h>

// Language IDs: 0 = English, 1 = Chinese
// Default is Chinese (user is Chinese-speaking)
enum LangId : uint8_t { LANG_EN = 0, LANG_ZH = 1, LANG_COUNT = 2 };

// Returns current language from settings (defined in stats.cpp)
LangId langCurrent();

// ---------- String IDs ----------
// Grouped by file/module. Each S_xxx has LANG_COUNT entries.
// Add new strings here and in the table below.

// --- settings.cpp ---
enum StrID : uint8_t {
  S_SETTINGS_TITLE,
  S_SETTINGS_BRIGHTNESS,
  S_SETTINGS_SOUND,
  S_SETTINGS_BLUETOOTH,
  S_SETTINGS_LED,
  S_SETTINGS_RESET,
  S_SETTINGS_BACK,
  S_SETTINGS_LANG,
  S_SETTINGS_ON,
  S_SETTINGS_OFF,
  S_SETTINGS_A_NEXT,
  S_SETTINGS_B_CHANGE,
  // --- menu.cpp ---
  S_MENU_TITLE,
  S_MENU_SETTINGS,
  S_MENU_SLEEP,
  S_MENU_ABOUT,
  S_MENU_POWER_OFF,
  S_MENU_CLOSE,
  S_MENU_REALLY,
  S_MENU_A_NEXT,
  S_MENU_B_SELECT,
  S_MENU_ABOUT_TITLE,
  S_MENU_PRODUCT,
  S_MENU_DEVICE,
  S_MENU_OWNER,
  S_MENU_PET,
  S_MENU_A_BACK,
  S_MENU_B_BACK,
  S_MENU_HELP_A,
  S_MENU_HELP_B,
  S_MENU_HELP_HOLD,
  // --- reset.cpp ---
  S_RESET_TITLE,
  S_RESET_DELETE_CHAR,
  S_RESET_FACTORY,
  S_RESET_BACK,
  S_RESET_REALLY,
  S_RESET_PRESS_B,
  S_RESET_A_NEXT,
  S_RESET_B_CONFIRM,
  // --- approval.cpp ---
  S_APPROVAL_AGENT_ASKS,
  S_APPROVAL_TOOL,
  S_APPROVAL_DETAIL,
  S_APPROVAL_A_ALLOW,
  S_APPROVAL_B_DENY,
  S_APPROVAL_SENT,
  // --- home.cpp ---
  S_HOME_WORKING,
  S_HOME_THINKING,
  S_HOME_DIZZY,
  S_HOME_ERROR,
  S_HOME_IDLE,
  S_HOME_NO_SESSIONS,
  S_HOME_1_SESSION,
  S_HOME_SESSIONS,
  S_HOME_A_NEXT,
  S_HOME_HOLD_A,
  // --- link.cpp ---
  S_LINK_LINKED,
  S_LINK_LINKING,
  S_LINK_STANDALONE,
  S_LINK_OFF,
  S_LINK_CHARGING,
  S_LINK_ON_USB,
  S_LINK_BATTERY,
  S_LINK_A_NEXT,
  S_LINK_B_RECONN,
  // --- main.cpp ---
  S_MAIN_BT_PAIRING,
  S_MAIN_ENTER_ON_DESKTOP,
  S_MAIN_INSTALLING,
  S_COUNT
};

// Returns the translated string for the given StrID in the current language.
const char* L(StrID id);

// Returns the translated string for a specific language (for settings preview).
const char* Lx(StrID id, LangId lang);
