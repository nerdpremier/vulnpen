import { Tooltip } from "antd";
import styles from "@/styles/pages/Session.module.scss";
import Image from "next/image";
import quad from "@/assets/sidebar/quad.svg";
import rect from "@/assets/sidebar/rect.svg";
import { useDispatch, useSelector } from "react-redux";
import { setRecon, updateCurrentSession, updateSessions } from "@/store/user.slice";
import { useRouter, usePathname } from "next/navigation";
import { useQuery } from "react-query";
import { getVulnerabilities } from "@/services/agent.service";
import { getTestPlan } from "@/services/websecurity.service";
import { FiCheckSquare, FiMonitor, FiAlertOctagon } from "react-icons/fi";
import { HiOutlineChevronLeft } from "react-icons/hi";

/**
 * Session rail.
 *
 * Three stacked zones: who/where you are at the top, the grouped view
 * navigation in the middle (Workspace / Testing / Views), and the session
 * utilities pinned to the bottom. The rail collapses to icons below 768px so
 * the workspace keeps its width on a laptop.
 */

const Sidebar = ({ sessionId, workspaceId }) => {
  const router = useRouter();
  const pathname = usePathname();
  const dispatch = useDispatch();

  const { data: vulnerabilitiesData } = useQuery(
    ["vulnerabilities", sessionId],
    () => getVulnerabilities(sessionId),
    { enabled: !!sessionId, refetchInterval: 5000, retry: false },
  );
  const { data: testPlanData } = useQuery(
    ["test-plan", sessionId],
    () => getTestPlan(sessionId),
    { enabled: !!sessionId, refetchInterval: 15000, retry: false },
  );
  const testPlanCoverage = testPlanData?.coverage;

  const { sessions } = useSelector((state) => state.user);

  const handleClickTab = (id) => {
    dispatch(updateCurrentSession(id));
    const selectedSession = sessions.filter((s) => s.id === id);
    if (selectedSession.length > 0) {
      router.push(`/session/${id}`);
    }
  };

  const navigateToGUI = () => {
    const guiId = `${sessionId}/gui`;
    let updatedSess = [...sessions];
    const exists = updatedSess.find((s) => s.id === guiId);
    if (!exists) {
      updatedSess = updatedSess.map((s) => ({ ...s, is_active: false }));
      updatedSess.push({ id: guiId, is_main: false, is_active: true, type: "gui" });
      dispatch(updateSessions(updatedSess));
    }
    router.push(`/session/${sessionId}/gui`);
  };

  const exitTarget = workspaceId
    ? `/workspace/${workspaceId}`
    : "/dashboard";

  const isOnWorkspace = pathname === `/session/${sessionId}`;
  const isOnGUI = pathname?.includes("/gui");
  const isOnVulnerabilities = pathname?.includes("/vulnerabilities");
  const isOnTestPlan = pathname?.includes("/test-plan");

  const mainSessions = sessions.filter((s) => s.is_main && s.type === "session");
  const subSessions = sessions.filter((s) => !s.is_main && s.type === "session");

  return (
    <aside className={styles.sidebar} aria-label="Session navigation">
      <div className={styles.sidebarTop}>
        <Tooltip title="All workspaces" placement="right">
          <button
            type="button"
            className={styles.navRow}
            aria-label={workspaceId ? "Back to workspace" : "Back to dashboard"}
            onClick={() => {
              dispatch(setRecon(false));
              router.push(exitTarget);
            }}
          >
            <HiOutlineChevronLeft size={13} />
            <span>{workspaceId ? "Workspace" : "Dashboard"}</span>
          </button>
        </Tooltip>
      </div>

      <nav className={styles.sidebarNav}>
        <div className={styles.navSectionLabel}>Workspace</div>

        {mainSessions.map((sess) => (
          <div
            key={sess.id}
            role="button"
            tabIndex={0}
            onClick={() => handleClickTab(sess.id)}
            onKeyDown={(event) => event.key === "Enter" && handleClickTab(sess.id)}
            className={sess?.is_active ? styles.activeTab : styles.tab}
          >
            <Image src={quad} width={14} height={14} alt="" />
            <span className={styles.navText}>Main workspace</span>
          </div>
        ))}

        {subSessions.map((sess, i) => (
          <div
            key={sess.id}
            role="button"
            tabIndex={0}
            onClick={() => handleClickTab(sess.id)}
            onKeyDown={(event) => event.key === "Enter" && handleClickTab(sess.id)}
            className={sess?.is_active ? styles.activeTab : styles.tab}
          >
            <Image src={rect} width={14} height={14} alt="" />
            <span className={styles.navText}>Sub workspace {i + 1}</span>
          </div>
        ))}

        <div
          role="button"
          tabIndex={0}
          onClick={() => router.push(`/session/${sessionId}`)}
          onKeyDown={(event) =>
            event.key === "Enter" && router.push(`/session/${sessionId}`)
          }
          className={isOnWorkspace ? styles.activeTab : styles.tab}
        >
          <Image src={quad} width={14} height={14} alt="" />
          <span className={styles.navText}>Chat</span>
        </div>

        <div className={styles.navSectionLabel}>Testing</div>

        <div
          role="button"
          tabIndex={0}
          onClick={() => router.push(`/session/${sessionId}/test-plan`)}
          onKeyDown={(event) =>
            event.key === "Enter" && router.push(`/session/${sessionId}/test-plan`)
          }
          className={isOnTestPlan ? styles.activeTab : styles.tab}
        >
          <FiCheckSquare />
          <span className={styles.navText}>Web Security Testing</span>
          {testPlanCoverage?.total > 0 && (
            <span className={styles.navBadge}>
              {testPlanCoverage.executed}/{testPlanCoverage.total}
            </span>
          )}
        </div>

        <div
          role="button"
          tabIndex={0}
          onClick={() => router.push(`/session/${sessionId}/vulnerabilities`)}
          onKeyDown={(event) =>
            event.key === "Enter" &&
            router.push(`/session/${sessionId}/vulnerabilities`)
          }
          className={isOnVulnerabilities ? styles.activeTab : styles.tab}
        >
          <FiAlertOctagon />
          <span className={styles.navText}>Vulnerabilities</span>
          {(vulnerabilitiesData?.total ?? 0) > 0 && (
            <span className={styles.navBadge}>{vulnerabilitiesData.total}</span>
          )}
        </div>

        <div className={styles.navSectionLabel}>Views</div>

        <div
          role="button"
          tabIndex={0}
          onClick={navigateToGUI}
          onKeyDown={(event) => event.key === "Enter" && navigateToGUI()}
          className={isOnGUI ? styles.activeTab : styles.tab}
        >
          <FiMonitor />
          <span className={styles.navText}>GUI</span>
        </div>
      </nav>
    </aside>
  );
};

export default Sidebar;
