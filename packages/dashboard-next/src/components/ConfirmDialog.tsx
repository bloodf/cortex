import { cloneElement, isValidElement, useState, type ReactElement, type ReactNode } from "react";
import { Button, Input, Modal } from "@lobehub/ui";

interface Props {
  trigger?: ReactNode;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  requireText?: string;
  onConfirm: () => void;
  /** Controlled open state (omit `trigger` when using this). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel = "Confirm",
  destructive,
  requireText,
  onConfirm,
  open: controlledOpen,
  onOpenChange,
}: Props) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = (o: boolean) => {
    if (isControlled) onOpenChange?.(o);
    else setInternalOpen(o);
  };
  const [text, setText] = useState("");
  const disabled = !!requireText && text.trim() !== requireText;

  const close = () => {
    setOpen(false);
    setText("");
  };

  // Lobe Modal has no trigger slot: wire the caller's trigger element to open.
  const triggerEl =
    trigger && isValidElement(trigger)
      ? cloneElement(
          trigger as ReactElement<{
            onClick?: (e: React.MouseEvent) => void;
          }>,
          {
            onClick: (e: React.MouseEvent) => {
              const orig = (trigger as ReactElement<{ onClick?: (e: React.MouseEvent) => void }>)
                .props.onClick;
              orig?.(e);
              if (!e.defaultPrevented) setOpen(true);
            },
          },
        )
      : trigger;

  return (
    <>
      {triggerEl}
      {open && (
        <Modal open={open} title={title} onCancel={close} footer={null}>
          {description && <div className="text-sm text-muted-foreground">{description}</div>}
          {requireText && (
            <div className="mt-3 space-y-2">
              <label className="text-xs text-muted-foreground">
                Type <span className="font-mono font-semibold">{requireText}</span> to confirm
              </label>
              <Input value={text} onChange={(e) => setText(e.target.value)} autoFocus />
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={close}>Cancel</Button>
            <Button
              type="primary"
              danger={destructive}
              disabled={disabled}
              onClick={() => {
                onConfirm();
                close();
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
