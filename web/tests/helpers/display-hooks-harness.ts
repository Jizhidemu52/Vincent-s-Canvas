/** Legacy direct-call harnesses do not mount React. Keep Chinese display
 * values/configuration identical while behavior tests exercise original data,
 * callbacks and payloads. Translation behavior has its own mounted tests. */
const identity = <T>(value: T): T => value;

export const displayHooksHarness = {
    displayNotice: identity,
    useDisplayText: () => identity,
    useDisplayValue: () => identity,
    useDisplayUiValue: () => identity,
    useDisplayConfig: () => identity,
};
