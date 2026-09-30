import { App } from "antd";
import { ExclamationCircleFilled } from "@ant-design/icons";

export const useConfirmPopUp = () => {
  const { modal } = App.useApp();

  return (props) => {
    modal.confirm({
      className: props.className,
      title: props.title,
      content: props.content,
      icon: props.icon ?? (
        <ExclamationCircleFilled style={{ color: "#ff4d4f" }} />
      ),
      okText: props.okText,
      cancelText: props.cancelText,
      onOk: props.onOk,
      onCancel: props.onCancel,
      okButtonProps: {
        style: {
          backgroundColor: props?.okButtonBg || "#a8323a",
          border: "none",
          borderRadius: "8px",
        },
      },
      cancelButtonProps: props?.cancelButtonProps || {
        style: {
          background: "rgba(255, 255, 255, 0.05)",
          borderColor: "rgba(255, 255, 255, 0.14)",
          color: "rgba(255, 255, 255, 0.75)",
          borderRadius: "8px",
        },
      },
    });
  };
};
