import { Modal } from "antd";
import styles from "@/styles/components/ModalComponent.module.scss";
import { RiCloseLine } from "react-icons/ri";

/**
 * Shared dialog shell: eyebrow-free title, supporting line, content, and a
 * single close affordance in the top-right. Every dialog in the app routes
 * through here so spacing, radius and the close target stay consistent.
 */
const ModalComponent = ({
  heading,
  subheading,
  description,
  children,
  show,
  setShow,
  width,
  maxWidth,
  destroyOnClose,
  keyboard,
  confirmLoading,
  onCancel,
  className,
  headerStyles,
  headingStyles,
  subheadingStyles,
  showClose = false,
  maskClosable,
  closeIcon,
}) => {
  const closeModal = () => {
    setShow(false);
  };

  const handleCancel = onCancel ? onCancel : closeModal;

  // A dialog that draws its own heading (the auth-shaped reset card does) would
  // otherwise pay for an empty header row: a 2rem close button plus its margin
  // above content that already starts with an eyebrow.
  const hasHeading = Boolean(heading || subheading);

  const closeButton = (floating) =>
    !showClose ? (
      <button
        type="button"
        className={`${styles.closeBtn}${floating ? ` ${styles.floatingClose}` : ""}`}
        onClick={handleCancel}
        aria-label="Close dialog"
      >
        <RiCloseLine />
      </button>
    ) : null;

  return (
    <Modal
      keyboard={keyboard}
      className={`${styles.modalContainer} ${className ? className : ""}`}
      open={show}
      centered
      width={width ? width : 700}
      style={{
        maxWidth: maxWidth ? maxWidth : "900px",
      }}
      destroyOnHidden={destroyOnClose}
      confirmLoading={confirmLoading}
      onCancel={handleCancel}
      maskClosable={maskClosable}
      closeIcon={closeIcon}
      footer={null}
      title={null}
    >
      {hasHeading ? (
        <div className={styles.headingController}>
          <div className={styles.headingtextController} style={headerStyles}>
            {heading && <h1 style={headingStyles}>{heading}</h1>}
            {subheading && (
              <p className={styles.subheading} style={subheadingStyles}>
                {subheading}
              </p>
            )}
          </div>
          {closeButton(false)}
        </div>
      ) : (
        closeButton(true)
      )}
      {description && <p className={styles.description}>{description}</p>}
      <div className={styles.body}>{children}</div>
    </Modal>
  );
};

export default ModalComponent;
