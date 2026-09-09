import { registerRoot } from "remotion";

import { RemotionRoot } from "./root.tsx";

// Production MVP Wave C1 -- the webpack entry point bundle() is pointed at.
//
// Two lines, and deliberately nothing else. Anything with a side effect placed here would run inside
// every rendered frame's browser context; anything importable placed here would be reachable only
// through the bundle. Both belong in the modules that own them.
registerRoot(RemotionRoot);
