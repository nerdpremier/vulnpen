import HeaderLinks from "@/components/common/HeaderLinks";
import ModelSetupGate from "@/components/common/ModelSetupGate";
import MoonBackdrop from "@/components/common/ui/MoonBackdrop";
import { AuthContextProvider } from "@/components/common/auth/AuthContext";
import styles from "@/styles/components/AppShell.module.scss";

/**
 * Authenticated chrome: ambient night sky, sticky header, scrollable content.
 * Shared by the dashboard and workspace routes so navigation and the visual
 * frame never drift between them.
 */
const DashboardLayout = ({ children }) => {
  return (
    <AuthContextProvider>
      <div className={styles.shell}>
        <MoonBackdrop variant="page" />
        <HeaderLinks />
        <main className={styles.content}>
          <ModelSetupGate>{children}</ModelSetupGate>
        </main>
      </div>
    </AuthContextProvider>
  );
};

export default DashboardLayout;
