import styles from "@/styles/pages/Terms.module.scss";

const TermsPage = () => {
  return (
    <div className={styles.termsContainer}>
      <h1>VulnPen Acceptable Use Policy</h1>
      <p>
        VulnPen is an internal web application security testing tool operated by
        T-NET IT Solution. It exists to support authorised penetration testing
        and security assessment work. By using it you agree to the terms below.
      </p>

      <ol>
        <li>
          <h2>Authorised testing only</h2>
          <p>
            You must have explicit written permission from the system owner
            before you point VulnPen at any application, API or host. Testing
            systems you do not own or have not been authorised to test is
            strictly prohibited and may be unlawful.
          </p>
        </li>

        <li>
          <h2>Scope and evidence</h2>
          <p>
            Keep testing inside the agreed scope. The evidence VulnPen records
            (requests, responses, findings and reports) is confidential client
            material: store it where the engagement requires and do not share it
            outside the engagement.
          </p>
        </li>

        <li>
          <h2>Prohibited use</h2>
          <p>
            Do not use VulnPen for unauthorised access, data exfiltration,
            denial of service, crypto mining, botnet operation or any activity
            outside a signed engagement. Misuse leads to immediate loss of
            access and may be reported to the relevant authorities.
          </p>
        </li>

        <li>
          <h2>No warranty</h2>
          <p>
            The tool is provided &quot;as is&quot;. Findings and draft reports
            are produced by an AI assistant and must be reviewed by a qualified
            tester before they are used or delivered to a client.
          </p>
        </li>

        <li>
          <h2>Contact</h2>
          <p>
            Questions about this policy should go to the security team at
            T-NET IT Solution.
          </p>
        </li>
      </ol>
    </div>
  );
};

export default TermsPage;