import { createSlice } from "@reduxjs/toolkit";

/**
 * The signed-in user's session slice.
 *
 * It holds exactly one thing: the signed-in `user`, which the header, the
 * account page and the session layout read. It used to carry a second life as a
 * workspace/session switcher (`sessions`, `updateSessions`,
 * `updateCurrentSession`, `closeSession`), a VNC handle (`vnc`, `updateVNC`), a
 * `recon` flag, an `isLoggedIn` mirror and an exploit-box lifecycle
 * (`expiresAt`, `status`, `readyToConnect`, `containerIP`, `noOfExtends`,
 * `cancelSource`, `disclaimer`). Nothing ever populated or read them — the rail
 * renders its own links, the desktop page owns its VNC connection, and the
 * exploit-box API this mirrored has no caller — so they are gone rather than
 * left as decoys.
 */
const initialState = {
  user: null,
};

export const userSlice = createSlice({
  name: "user",
  initialState,

  reducers: {
    loginUser: (state, action) => {
      state.user = action.payload;
    },
    /**
     * Returning the initial state replaces the draft. Assigning
     * `state = initialState` would only rebind the parameter and leave the
     * store untouched, so sign-out would never clear `user`.
     */
    logout: () => initialState,
  },
});

export const { loginUser, logout } = userSlice.actions;
export default userSlice.reducer;
