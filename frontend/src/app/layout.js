// antd v5 targets React 16-18. This official patch restores the static
// methods and the wave/render callbacks React 19 removed, and silences the
// "[antd: compatible] antd v5 support React is 16 ~ 18" warning.
// Must be imported before any antd component renders.
import "@ant-design/v5-patch-for-react-19";

// styles
import "./globals.scss";
import "antd/dist/reset.css";
import "@xterm/xterm/css/xterm.css";
import { Inter } from "next/font/google";
import QueryClientContext from "@/components/common/auth/QueryClient";
import StoreProvider from "@/components/common/auth/StoreProvider";

const inter = Inter({ subsets: ["latin"] });

export const metadata = {
  title: "VulnPen",
  description:
    "VulnPen is an AI assistant for web application security testing: it plans and executes OWASP WSTG v4.2 test cases, analyses the results, maps findings to the OWASP Top 10:2025 and drafts the web application penetration testing report.",
  robots: "noindex, nofollow",
  metadataBase: new URL("http://localhost:3000"),
  icons: { icon: "/t-net-logo.png", apple: "/t-net-logo.png" },
};
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <StoreProvider>
          <QueryClientContext>

            {children}
          </QueryClientContext>
        </StoreProvider>
      </body>
    </html>
  );
}
