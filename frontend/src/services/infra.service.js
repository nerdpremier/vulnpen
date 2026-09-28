import { apiClient } from "@/utils/axios.config";

// ─── VPN profiles and tunnels ────────────────────────────────────────

export const uploadVPNProfile = async (data) => {
  const res = await apiClient.post(`/infra/vpn/profiles/upload`, data, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return res.data;
};

export const listVPNProfiles = async () => {
  const res = await apiClient.get(`/infra/vpn/profiles`);
  return res.data;
};

export const deleteVPNProfile = async (body) => {
  const res = await apiClient.post(`/infra/vpn/profiles/delete`, body);
  return res.data;
};

export const connectVPNProfile = async (body) => {
  const res = await apiClient.post(`/infra/vpn/connect`, body);
  return res.data;
};

export const disconnectVPNConnection = async (body) => {
  const res = await apiClient.post(`/infra/vpn/disconnect`, body);
  return res.data;
};

export const disconnectAllVPNConnections = async (body) => {
  const res = await apiClient.post(`/infra/vpn/disconnect-all`, body);
  return res.data;
};

export const getVPNStatus = async (body) => {
  const res = await apiClient.post(`/infra/vpn/status`, body);
  return res.data;
};

// ─── Remote desktop (noVNC) ──────────────────────────────────────────

export const connectToVNC = async (body) => {
  const res = await apiClient.post(`/infra/connect-vnc`, body);
  return res.data;
};