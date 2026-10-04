"use client";

import { useState, useEffect, useCallback } from "react";
import { Result } from "antd";
import { RiAccountCircleLine, RiCloseLine } from "react-icons/ri";
import {
  TbTools,
  TbBrain,
  TbRadar,
  TbWorldWww,
  TbAdjustmentsHorizontal,
  TbPlugConnected,
} from "react-icons/tb";
import styles from "@/styles/components/SettingsOverlay.module.scss";
import MyAccount from "@/components/pages/settings/MyAccount";
import CapabilitiesPage from "@/components/pages/settings/Capabilities";
import ModelsPage from "@/components/pages/settings/Models";
import BurpSettingsPage from "@/components/pages/settings/BurpSettings";
import MagnitudeSettingsPage from "@/components/pages/settings/MagnitudeSettings";
import AgentBehaviorPage from "@/components/pages/settings/AgentBehavior";
import SSHConnectionPage from "@/components/pages/session/connection/SSHConnectionPage";
import VPNMainPage from "@/components/pages/session/vpn/VPNMainPage";

// Session-scoped tabs only render meaningful content inside a session
// (HeaderLinks passes sessionId). Hidden from the tab list otherwise.
const SESSION_TABS = [
  {
    key: "connection",
    section: "Session",
    label: "Connection",
    description: "Workspace host and exploit-box connection for this session.",
    icon: TbPlugConnected,
    component: SSHConnectionPage,
  },
  {
    key: "vpn",
    section: "Session",
    label: "VPN",
    description: "OpenVPN status and control for this session's workspace.",
    icon: TbWorldWww,
    component: VPNMainPage,
  },
];

const TABS = [
  {
    key: "account",
    section: "Account",
    label: "My Account",
    icon: RiAccountCircleLine,
    component: MyAccount,
  },
  {
    key: "models",
    section: "Agent",
    label: "Models",
    description:
      "Configure reusable model presets and assign them to the orchestrator and browser agent.",
    icon: TbBrain,
    component: ModelsPage,
  },
  {
    key: "agent-behavior",
    section: "Agent",
    label: "Agent Behavior",
    description:
      "Configure how long autonomous agent runs can continue before pausing.",
    icon: TbAdjustmentsHorizontal,
    component: AgentBehaviorPage,
  },
  {
    key: "capabilities",
    section: "Tools & integrations",
    label: "Tools",
    description:
      "Manage CLI tools and Python packages available on your exploit box.",
    icon: TbTools,
    component: CapabilitiesPage,
  },
  {
    key: "burp",
    section: "Tools & integrations",
    label: "Burp Suite",
    description: "Connect to a Burp Suite instance via the Burp RPC extension.",
    icon: TbRadar,
    component: BurpSettingsPage,
  },
  {
    key: "magnitude",
    section: "Tools & integrations",
    label: "Browser Agent",
    description:
      "Configure Magnitude for agentic browser automation during pentests.",
    icon: TbWorldWww,
    component: MagnitudeSettingsPage,
  },
];

/** Section headings, in display order; tabs without a matching section fall back to the end. */
const SECTION_ORDER = ["Account", "Agent", "Tools & integrations", "Session"];

const SettingsOverlay = ({ open, onClose, initialTab, sessionId }) => {
  const [activeTab, setActiveTab] = useState(initialTab || "account");

  const visibleTabs = [...TABS, ...(sessionId ? SESSION_TABS : [])];

  // Group tabs by section, keeping SECTION_ORDER for headings.
  const groupedTabs = SECTION_ORDER.map((section) => ({
    section,
    tabs: visibleTabs.filter((tab) => tab.section === section),
  })).filter((group) => group.tabs.length > 0);

  useEffect(() => {
    if (initialTab && open) {
      // Reset the tab when an external settings link opens the overlay.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveTab(initialTab);
    }
  }, [initialTab, open]);

  const handleEscape = useCallback(
    (e) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  useEffect(() => {
    if (open) {
      document.addEventListener("keydown", handleEscape);
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.removeEventListener("keydown", handleEscape);
      document.body.style.overflow = "";
    };
  }, [open, handleEscape]);

  if (!open) return null;

  const currentTab = visibleTabs.find((t) => t.key === activeTab) || TABS[0];
  const ActiveComponent = currentTab.component;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.sidebar}>
          <div className={styles.sidebarBrand}>
            <div className={styles.sidebarBrandText}>
              <span className={styles.sidebarBrandName}>VulnPen</span>
              <span className={styles.sidebarTitle}>Settings</span>
            </div>
          </div>
          <div className={styles.navItems}>
            {groupedTabs.map(({ section, tabs }) => (
              <div key={section} className={styles.navGroup}>
                <div className={styles.navGroupLabel}>{section}</div>
                {tabs.map((tab) => (
                  <div
                    key={tab.key}
                    className={
                      activeTab === tab.key ? styles.navItemActive : styles.navItem
                    }
                    onClick={() => setActiveTab(tab.key)}
                  >
                    <tab.icon className={styles.navIcon} />
                    {tab.label}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>

        <div className={styles.content}>
          <div className={styles.contentHeader}>
            <div>
              <div className={styles.contentTitle}>{currentTab.label}</div>
            </div>
            <button className={styles.closeButton} onClick={onClose}>
              <RiCloseLine />
            </button>
          </div>
          <div className={styles.contentBody}>
            {sessionId || !SESSION_TABS.some((t) => t.key === currentTab.key) ? (
              <ActiveComponent onNavigate={setActiveTab} sessionId={sessionId} />
            ) : (
              <Result
                status="info"
                title="Session required"
                subTitle="This setting is per-session. Open it from inside a session via the gear icon."
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsOverlay;

