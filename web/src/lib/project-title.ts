import { uiText } from "./i18n";

export function nextProjectTitle(projects: readonly { title: string }[], prefix = uiText("无限画布")) {
    const titles = new Set(projects.map(project => project.title.trim()));
    let number = 1;
    while (titles.has(`${prefix} ${number}`)) number++;
    return `${prefix} ${number}`;
}
