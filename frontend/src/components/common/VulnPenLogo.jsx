import Image from "next/image";

/**
 * VulnPen brand mark (T-NET IT Solution). Sizing lives in globals.scss
 * (.vulnpen-logo) so the header, login and register views all render the same
 * dimensions.
 */
const VulnPenLogo = ({ plain }) => {
  return (
    <span className={plain ? "vulnpen-logo vulnpen-logo-plain" : "vulnpen-logo"}>
      <Image
        src="/t-net-logo.png"
        alt="VulnPen by T-NET IT Solution"
        width={875}
        height={791}
        priority
      />
    </span>
  );
};

export default VulnPenLogo;