/** sessionStorage key: CTF tab → chat pending `/solve` after clear-context + navigate */
export const PENDING_CTF_SOLVE_KEY = "vulnpen:pending-ctf-solve";

/** Fired after navigating from CTF → chat so pending /solve runs even if ChatView did not remount */
export const PENDING_SOLVE_READY_EVENT = "vulnpen:pending-solve-ready";
