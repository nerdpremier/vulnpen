import { createSlice } from "@reduxjs/toolkit";

/**
 * The signed-in user's session slice.
 *
 * It used to carry a second life as a workspace/session switcher (`sessions`,
 * `updateSessions`, `updateCurrentSession`, `closeSession`) and a VNC handle
 * (`vnc`, `updateVNC`) plus a `recon` flag. Nothing ever populated or read them
 * — the rail renders its own links and the desktop page owns its own VNC
 * connection — so they are gone rather than left as decoys. `resetSessions`
 * survives because the dashboard calls it on mount.
 */
const initialState = {
  user: null,
  isLoggedIn: false,
  expiresAt: null,
  status: "stopped",
  readyToConnect: false,
  disclaimer: false,
  containerIP: null,
  noOfExtends: 0,
  cancelSource: null,
};

export const userSlice = createSlice({
  name: "user",
  initialState,

  reducers: {
    loginUser: (state, action) => {
      state.user = action.payload;
      state.isLoggedIn = true;
    },
    update: (state, action) => {
      const prevUser = state.user;
      state.user = { ...prevUser, ...action.payload };
    },
    logout: (state) => {
      state = initialState;
    },
    updateExploitBox: (state, action) => {
      state.expiresAt = action.payload.expiresAt;
      state.noOfExtends = action.payload.extends;
      state.status = action.payload.status;
      state.readyToConnect = action.payload.readyToConnect;
      state.containerIP = action.payload.containerIP;
    },
    updateExpiry: (state, action) => {
      state.expiresAt = action.payload.expiresAt;
      state.noOfExtends = action.payload.extends;
      // state.status = action.payload.status;
      // state.readyToConnect = action.payload.readyToConnect;
      // state.containerIP = action.payload.containerIP;
    },
    expireContainer: (state, action) => {
      state.expiresAt = null;
      state.noOfExtends = 0;
      state.status = "stopped";
    },
    updateDisclaimer: (state, action) => {
      state.disclaimer = action.payload;
    },
    updateCancelSource: (state, action) => {
      state.cancelSource = action.payload;
    },
  },
});

export const {
  loginUser,
  update,
  logout,
  updateExpiry,
  updateExploitBox,
  expireContainer,
  updateDisclaimer,
} = userSlice.actions;
export default userSlice.reducer;
