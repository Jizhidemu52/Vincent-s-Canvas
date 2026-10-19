type SubmitKeyEvent = {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    repeat: boolean;
    nativeEvent: { isComposing?: boolean; keyCode?: number };
    preventDefault: () => void;
};

export function handleSubmitShortcut(event: SubmitKeyEvent, enabled: boolean, submit: () => void) {
    if (!enabled || event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.repeat || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    event.preventDefault();
    submit();
}
