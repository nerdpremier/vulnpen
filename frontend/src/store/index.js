import { configureStore, combineReducers } from "@reduxjs/toolkit";
import userReducer from "./user.slice";
import vpnReducer from "./vpn.slice";

import { persistReducer } from "redux-persist";
import storage from "redux-persist/lib/storage";

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
      getDefaultMiddleware({
        serializabilityCheck: {
          ignoredActions: ["persist/PERSIST", "persist/REHYDRATE"],
        },
      }),
    devTools: process.env.NODE_ENV !== "production",
  });
};

const store = createAppStore();

export default store;
