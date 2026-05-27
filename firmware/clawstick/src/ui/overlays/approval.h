#pragma once
#include <stdint.h>
#include "../../data.h"

// Approval overlay (plan §3.6 / §3.5.1). Full-screen overlay that
// preempts whichever main card is showing. Called from main.cpp once
// per frame while the approval should be visible. The overlay itself
// has no state — main.cpp owns promptArrivedMs / responseSent / the
// post-response 1.5s "sent..." hold-then-clear logic, and passes the
// derived signals in. This file just paints whichever phase is asked
// for: live (countdown + tool + hint + allow/deny) or sent.

namespace ui_approval {

void render(const TamaState& tama,
            uint32_t promptArrivedMs,
            bool responseSent);

}  // namespace ui_approval
