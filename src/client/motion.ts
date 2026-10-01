/** Read on each call, since the setting can change while the page is open. */
export function reducedMotion(): boolean {
    return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** For scrollIntoView: smooth, unless the user asked for less motion. */
export function scrollBehavior(): ScrollBehavior {
    return reducedMotion() ? "auto" : "smooth";
}
