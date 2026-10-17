import { apiClient } from "@/utils/axios.config";

export const login = async ({ email, password }) => {
  const response = await apiClient.post("/auth/login", {
    email,
    password,
  });

  return response.data;
};

export const register = async ({ name, email, password }) => {
  const response = await apiClient.post("/auth/register", {
    name,
    email,
    password,
  });

  return response.data;
};

export const getRegistrationStatus = async () => {
  const response = await apiClient.get("/auth/registration-status");
  return response.data;
};

// Self-service password change: the current password is part of the request so
// a borrowed session cannot lock the real owner out.
export const changePassword = async ({
  currentPassword,
  newPassword,
  confirmPassword,
}) => {
  const response = await apiClient.post("/auth/change-password", {
    currentPassword,
    newPassword,
    confirmPassword,
  });

  return response.data;
};


// Public reset: the email selects the account and the new password is applied
// immediately, because this installation has no way to send a verification
// message. Keep the port behind the TLS proxy.
export const resetPassword = async ({ email, newPassword }) => {
  const response = await apiClient.post("/auth/reset-password", {
    email,
    newPassword,
  });

  return response.data;
};

export const checkSession = async () => {
  try {
    const response = await apiClient.get("/auth/status");
    return response.data;
  } catch (error) {
    const status = error?.response?.status;
    // 400/401/403: no session cookie. A normal state, not a failure — return a
    // marker so react-query never logs a rejection.
    if (status === 400 || status === 401 || status === 403) {
      return { success: false, user: null };
    }
    // Anything else is an outage (no response, timeout, 5xx). Treating it as
    // "session expired" logged the operator out and told them something false
    // about their own session, so it is reported separately and retried.
    return {
      success: false,
      user: null,
      unreachable: true,
      reason: error?.response?.data?.message || error?.message || "No response",
    };
  }
};

export const logoutUser = async () => {
  const response = await apiClient.post("/auth/logout");

  return response.data;
};
