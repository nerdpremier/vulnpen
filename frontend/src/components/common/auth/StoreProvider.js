"use client";

// antd v5 was built for React <=18; this official patch restores the
// React 19 APIs it needs and silences the "antd v5 support React is 16 ~ 18"
// console warning.
import "@ant-design/v5-patch-for-react-19";

import { Provider } from "react-redux";
import { persistStore } from "redux-persist";
import { PersistGate } from "redux-persist/integration/react";
import store from "@/store";

const persistor = persistStore(store);

const StoreProvider = ({ children }) => {
  return (
    <>
      <Provider store={store}>
        <PersistGate loading={null} persistor={persistor}>
          {children}
        </PersistGate>
      </Provider>
    </>
  );
};

export default StoreProvider;
