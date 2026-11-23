// Movement is compiled in one translation unit so the compiler can inline
// across these focused modules without introducing dispatch or allocations.
#include "motion_support.inc"
#include "gravity_motion.inc"
#include "translations.inc"
#include "slope_geometry.inc"
#include "lifts.inc"
#include "slope_proposals.inc"
#include "slope_motion.inc"
#include "gravity_queries.inc"
