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


export const checkSession = async () => {
  try {
    const response = await apiClient.get("/auth/status");
    return response.data;
  } catch {
    // No/invalid session cookie is a normal state (the backend answers 400),
    // not an error — return a marker so react-query never logs a rejection.
    return { success: false, user: null };
  }
};

export const logoutUser = async () => {
  const response = await apiClient.post("/auth/logout");

  return response.data;
};
