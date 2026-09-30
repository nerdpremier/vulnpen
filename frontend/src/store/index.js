import { configureStore, combineReducers, createSerializableStateInvariantMiddleware } from "@reduxjs/toolkit";
import userReducer from "./user.slice";
import vpnReducer from "./vpn.slice";

import { persistReducer } from "redux-persist";
import storage from "redux-persist/lib/storage";

// redux-persist dispatches these internal actions (PERSIST carries functions
// in its payload) on every mount; RTK 2 ignores the ignoredActions config
// passed through getDefaultMiddleware, so a dedicated serializable
// middleware with the ignore list is required to keep them out of the
// Next.js dev overlay.
const PERSIST_ACTIONS = [
  "persist/FLUSH",
  "persist/REHYDRATE",
  "persist/PAUSE",
  "persist/PERSIST",
  "persist/PURGE",
  "persist/REGISTER",
];

const isClient = typeof window !== "undefined";

const reducers = combineReducers({
  user: userReducer,
  vpn: vpnReducer,
});

const createAppStore = () => {
  if (!isClient) {
    // Server: plain store, no persistence (storage needs window).
    return configureStore({
      reducer: reducers,
    });
  }

  const persistConfig = {
    key: "root",
    storage,
    whitelist: ["user", "vpn"],
  };

  return configureStore({
    reducer: persistReducer(persistConfig, reducers),
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({ serializableCheck: false }).concat(
        createSerializableStateInvariantMiddleware({
          ignoredActions: PERSIST_ACTIONS,
        }),
      ),
    devTools: process.env.NODE_ENV !== "production",
  });
};

const store = createAppStore();

export default store;
