import { message, Spin, Upload, Empty, Popconfirm } from "antd";
import PrimaryButton from "@/components/common/PrimaryButton";
import { useMutation, useQuery, useQueryClient } from "react-query";
import {
  listVPNProfiles,
  uploadVPNProfile,
  deleteVPNProfile,
  connectVPNProfile,
  disconnectVPNConnection,
  disconnectAllVPNConnections,
  getVPNStatus,
} from "@/services/infra.service";
import { FiRefreshCw, FiUpload, FiTrash2, FiWifi, FiWifiOff } from "react-icons/fi";
import { MdOutlineVpnLock } from "react-icons/md";
import { useState } from "react";
import {
  AnimatedContent,
  PageState,
  StatStrip,
  StatTile,
} from "@/components/common/ui";
import styles from "@/styles/components/VPN.module.scss";

/**
 * The tunnel state as a shape: a dot in the state's own colour, with the live
 * one pulsing. Three states never look alike — a tunnel that is up, a profile
 * that is idle, and a status the API did not answer for are different facts.
 */
const TunnelState = ({ state, label }) => (
  <span className={`${styles.stateChip} ${styles[`state_${state}`]}`}>
    <span className={styles.stateDot} aria-hidden="true" />
    {label}
  </span>
);

const VPNMainPage = ({ sessionId }) => {
  const queryClient = useQueryClient();

  const [uploading, setUploading] = useState(false);
  const [activeConnectProfile, setActiveConnectProfile] = useState(null);

  const {
    data: profilesData,
    isLoading: profilesLoading,
    isError: profilesError,
    refetch: refetchProfiles,
  } = useQuery(
    ["vpn-profiles"],
    listVPNProfiles,
    { refetchInterval: 15000 }
  );

  const {
    data: vpnStatusData,
    isError: vpnStatusError,
    refetch: refetchVpnStatus,
  } = useQuery(
    ["check-vpn-status", sessionId],
    () => getVPNStatus({ session_id: sessionId }),
    { refetchInterval: 5000 }
  );

  // An unread status is not "no connections": treating the two the same would
  // offer Connect on a tunnel that is already up.
  const vpnConnections = vpnStatusData?.connections ?? [];
  const vpnStatusUnknown = vpnStatusError;

  const uploadMutation = useMutation(uploadVPNProfile, {
    onSuccess: (data) => {
      message.success(data?.message ?? "Profile uploaded");
      queryClient.invalidateQueries(["vpn-profiles"]);
      setUploading(false);
    },
    onError: (err) => {
      message.error(err?.response?.data?.message ?? "Upload failed");
      setUploading(false);
    },
  });

  const deleteMutation = useMutation(deleteVPNProfile, {
    onSuccess: () => {
      message.success("Profile deleted");
      queryClient.invalidateQueries(["vpn-profiles"]);
    },
    onError: (err) => {
      message.error(err?.response?.data?.message ?? "Delete failed");
    },
  });

  const connectMutation = useMutation(connectVPNProfile, {
    onSuccess: (data) => {
      setActiveConnectProfile(null);
      message.success(data?.message ?? "Connected");
      queryClient.invalidateQueries(["check-vpn-status", sessionId]);
    },
    onError: (err) => {
      setActiveConnectProfile(null);
      message.error(err?.response?.data?.message ?? "Connection failed");
    },
  });

  const disconnectMutation = useMutation(disconnectVPNConnection, {
    onSuccess: () => {
      message.success("Disconnected");
      queryClient.invalidateQueries(["check-vpn-status", sessionId]);
    },
    onError: (err) => {
      message.error(err?.response?.data?.message ?? "Disconnect failed");
    },
  });

  const disconnectAllMutation = useMutation(disconnectAllVPNConnections, {
    onSuccess: () => {
      message.success("All VPN connections terminated");
      queryClient.invalidateQueries(["check-vpn-status", sessionId]);
    },
    onError: (err) => {
      message.error(err?.response?.data?.message ?? "Failed to disconnect all");
    },
  });

  const profiles = profilesData?.profiles ?? [];

  const isProfileConnected = (profileName) => {
    return vpnConnections.some((c) => c.profile_name === profileName);
  };

  const getConnectionForProfile = (profileName) => {
    return vpnConnections.find((c) => c.profile_name === profileName);
  };

  const uploadProps = {
    accept: ".ovpn,.conf,.crt,.key,.pem,.p12,.pfx,.txt",
    multiple: true,
    showUploadList: false,
    beforeUpload: async (file, fileList) => {
      if (file.uid !== fileList[0]?.uid) return Upload.LIST_IGNORE;
      const profiles = fileList.filter((entry) => /\.(ovpn|conf)$/i.test(entry.name));
      if (profiles.length !== 1) {
        message.error("Select exactly one .ovpn or .conf file, plus any referenced certificates or keys");
        return Upload.LIST_IGNORE;
      }
      setUploading(true);
      const formData = new FormData();
      fileList.forEach((entry) => formData.append("files", entry));
      formData.append("profile_name", profiles[0].name.replace(/\.(ovpn|conf)$/i, ""));
      await uploadMutation.mutateAsync(formData);
      return false;
    },
  };

  /* Everything the readout needs is already in the two queries above: how many
     tunnels are up, how many bundles exist, and whether the tunnel status is
     readable at all. */
  const upCount = vpnConnections.length;
  const idleCount = Math.max(profiles.length - new Set(vpnConnections.map((c) => c.profile_name)).size, 0);

  return (
    <div className={styles.vpnContainer}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <h2 className={styles.headerTitle}>
            <MdOutlineVpnLock size={18} className={styles.headerIcon} />
            VPN Connections
          </h2>
          <p className={styles.headerSubtitle}>
            OpenVPN profiles and live tunnels on this workspace host
          </p>
        </div>
        <div className={styles.headerRight}>
          <Upload {...uploadProps}>
            <PrimaryButton purple icon={<FiUpload />} loading={uploading} size="small">
              Add VPN Bundle
            </PrimaryButton>
          </Upload>
          {vpnConnections.length > 1 && (
            <Popconfirm
              title="Disconnect all VPN connections?"
              onConfirm={() => disconnectAllMutation.mutate({ session_id: sessionId })}
              okText="Disconnect All"
              cancelText="Cancel"
            >
              <PrimaryButton danger size="small" loading={disconnectAllMutation.isLoading}>
                Disconnect All
              </PrimaryButton>
            </Popconfirm>
          )}
        </div>
      </div>

      <div className={styles.content}>
        <StatStrip className={styles.readout} role="group" aria-label="VPN state">
          <StatTile
            label="Tunnels up"
            value={upCount}
            tone={upCount ? "success" : "neutral"}
            hint={upCount ? "active OpenVPN sessions" : "nothing connected"}
          />
          <StatTile
            label="Profiles"
            value={profiles.length}
            hint="uploaded bundles"
          />
          <StatTile
            label="Idle"
            value={idleCount}
            hint="profiles with no tunnel"
          />
          <StatTile
            label="Tunnel status"
            value={vpnStatusUnknown ? "Unknown" : "Readable"}
            tone={vpnStatusUnknown ? "warning" : "neutral"}
            hint={
              vpnStatusUnknown
                ? "the status call did not answer"
                : "polled every 5 seconds"
            }
          />
        </StatStrip>

        {vpnConnections.length > 0 && (
          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>Active Connections</h3>
            <div className={styles.cardList}>
              {vpnConnections.map((conn, index) => (
                <AnimatedContent key={conn.pid} delay={index * 40}>
                  <div className={styles.cardActive}>
                    <div className={styles.cardRow}>
                      <div className={styles.cardLeft}>
                        <div className={styles.cardTitle}>
                          <TunnelState state="connected" label="Connected" />
                          <span className={styles.cardName}>{conn.profile_name}</span>
                        </div>
                        <div className={styles.cardMeta}>
                          <span>PID {conn.pid}</span>
                          {conn.tun_interface && (
                            <>
                              <span className={styles.cardMetaDot}>&bull;</span>
                              <span className={styles.cardMetaChip}>{conn.tun_interface}</span>
                            </>
                          )}
                          {conn.tun_ip && (
                            <>
                              <span className={styles.cardMetaDot}>&bull;</span>
                              <span className={styles.cardMetaIp}>{conn.tun_ip}</span>
                            </>
                          )}
                        </div>
                      </div>
                      <div className={styles.cardRight}>
                        <PrimaryButton
                          danger
                          size="small"
                          icon={<FiWifiOff />}
                          loading={disconnectMutation.isLoading}
                          onClick={() =>
                            disconnectMutation.mutate({
                              session_id: sessionId,
                              pid: conn.pid,
                              profile_name: conn.profile_name,
                            })
                          }
                        >
                          Disconnect
                        </PrimaryButton>
                      </div>
                    </div>
                  </div>
                </AnimatedContent>
              ))}
            </div>
          </div>
        )}

        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Saved Profiles</h3>

          {profilesLoading ? (
            <div className={styles.loadingState}>
              <Spin />
            </div>
          ) : profilesError ? (
            /* A failed read is not an empty folder: without this the page
               reported "no VPN profiles yet" for a backend that never answered. */
            <PageState
              state="error"
              compact
              title="Could not load the VPN profiles"
              description="The profile list could not be read. Uploaded profiles are still on disk."
              onRetry={() => refetchProfiles()}
            />
          ) : profiles.length === 0 ? (
            <Empty
              description={
                <span className={styles.emptyHint}>
                  No VPN profiles yet. Upload one .ovpn/.conf file with any referenced certificate or key files.
                </span>
              }
              className={styles.emptyState}
            />
          ) : (
            <div className={styles.cardList}>
              {profiles.map((profile, index) => {
                const connected = isProfileConnected(profile.name);
                const conn = getConnectionForProfile(profile.name);
                return (
                  <AnimatedContent key={profile.filename} delay={index * 40}>
                    <div className={connected ? styles.cardActive : styles.card}>
                      <div className={styles.cardRow}>
                        <div className={styles.cardLeft}>
                          <div className={styles.cardTitle}>
                            {connected ? (
                              <TunnelState state="connected" label="Active" />
                            ) : vpnStatusUnknown ? (
                              /* Not "IDLE": the tunnel state is unknown, and the
                                 two must not look the same. */
                              <TunnelState state="unknown" label="Unknown" />
                            ) : (
                              <TunnelState state="idle" label="Idle" />
                            )}
                            <span className={styles.cardName}>{profile.name}</span>
                          </div>
                          <div className={styles.cardMeta}>
                            <span className={styles.cardMetaFile}>{profile.filename}</span>
                            {conn?.tun_ip && (
                              <>
                                <span className={styles.cardMetaDot}>&bull;</span>
                                <span className={styles.cardMetaIp}>{conn.tun_ip}</span>
                              </>
                            )}
                          </div>
                        </div>
                        <div className={styles.cardRight}>
                          <div className={styles.actionGroup}>
                            {vpnStatusUnknown ? (
                              <PrimaryButton
                                size="small"
                                icon={<FiRefreshCw />}
                                onClick={() => refetchVpnStatus()}
                              >
                                Retry status
                              </PrimaryButton>
                            ) : connected ? (
                              <PrimaryButton
                                danger
                                size="small"
                                icon={<FiWifiOff />}
                                loading={disconnectMutation.isLoading}
                                onClick={() =>
                                  disconnectMutation.mutate({
                                    session_id: sessionId,
                                    profile_name: profile.name,
                                  })
                                }
                              >
                                Disconnect
                              </PrimaryButton>
                            ) : (
                              <PrimaryButton
                                green
                                size="small"
                                icon={<FiWifi />}
                                loading={
                                  connectMutation.isLoading &&
                                  activeConnectProfile === profile.name
                                }
                                onClick={() => {
                                  setActiveConnectProfile(profile.name);
                                  connectMutation.mutate({
                                    session_id: sessionId,
                                    profile_name: profile.name,
                                  });
                                }}
                              >
                                Connect
                              </PrimaryButton>
                            )}
                            <Popconfirm
                              title={`Delete profile "${profile.name}"?`}
                              onConfirm={() =>
                                deleteMutation.mutate({ profile_name: profile.name })
                              }
                              okText="Delete"
                              cancelText="Cancel"
                            >
                              <PrimaryButton
                                danger
                                size="small"
                                icon={<FiTrash2 />}
                                loading={deleteMutation.isLoading}
                              />
                            </Popconfirm>
                          </div>
                        </div>
                      </div>
                    </div>
                  </AnimatedContent>
                );
              })}
            </div>
          )}
        </div>

      </div>
    </div>
  );
};

export default VPNMainPage;
