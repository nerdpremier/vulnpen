import styles from "@/app/page.module.scss";
import Image from "next/image";
import laptop from "@/assets/laptop.svg";

const MobileScreen = () => {
  return (
    <div className={styles.mobileWrapper}>
      <Image src={laptop} alt="" draggable={false} width={300} height={300} />
      <h3>Use VulnPen on a larger screen</h3>
      <p>
        The testing workspace needs a desktop-size viewport: test plans,
        findings, evidence and the report draft are all laid out for it. Open
        VulnPen on a laptop or desktop to run an engagement.
      </p>
    </div>
  );
};

export default MobileScreen;