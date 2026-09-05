export function shouldBypassStandaloneAuthGate(standalone: boolean, admin = false) {
    return standalone && !admin;
}

export function shouldBypassStandaloneModuleGate(standalone: boolean) {
    return standalone;
}
