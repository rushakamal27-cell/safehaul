/**
 * lib/i18n/translations.ts
 *
 * Static UI-chrome dictionary for SafeHaul's presentation-layer
 * localization (English default, Russian second language — see
 * lib/i18n/LanguageContext.tsx). This file holds only fixed, static
 * strings (headers, buttons, labels, empty states). Dynamic/canonical
 * values (risk level, factor names, recommendations, DriverEvent types,
 * Audit badges/titles) are translated separately by the other
 * lib/i18n/*.ts modules, each with its own fallback-to-English rule, so a
 * missing/unknown dynamic value never breaks this static dictionary's
 * guarantee.
 *
 * `translate()` never throws and never renders blank: an unknown key
 * falls back to the English string, and an unknown language falls back to
 * `en`. This mirrors the fallback discipline used across lib/i18n/*.
 */

export type Language = "en" | "ru";

export const translations = {
  en: {
    // ── Navigation ──────────────────────────────────────────────────────
    navHeadsUp: "Heads-Up",
    navInspect: "Inspect",
    navAudit: "Audit",
    navSettings: "Settings",

    // ── Common ──────────────────────────────────────────────────────────
    cancel: "Cancel",

    // ── Dashboard / Heads-Up ────────────────────────────────────────────
    riskLow: "Low Risk",
    riskMedium: "Medium Risk",
    riskHigh: "High Risk",
    riskCritical: "Critical Risk",
    statusFullyLive: "Fully live",
    statusPartiallyLive: "Partially live",
    statusPublicDemo: "Public Demo",
    greetingMorning: "Good morning",
    greetingAfternoon: "Good afternoon",
    greetingEvening: "Good evening",
    driveSafelyToday: "Drive safely today.",
    realtimePredictiveRisk: "Real-time predictive risk",
    failedLoadRisk: "Failed to load risk data. Please try again.",
    primaryRiskFactors: "Primary risk factors",
    liveInputsOf: "Live inputs: {count} of {total}",
    contextIncomplete: "Context incomplete: {list} data unavailable.",
    initiateIncidentProtocol: "Initiate Incident Protocol",
    incidentDescription: "Incident description",
    incidentPlaceholder: "Briefly describe what happened...",
    submitting: "Submitting...",
    submitReport: "Submit report",
    todaysSummary: "Today's Summary",
    checksPassed: "Checks\npassed",
    milesDrivenLabel: "Miles\ndriven",
    alertsActive: "Alerts\nactive",
    recommendations: "Recommendations",
    recCategoryFatigue: "Fatigue",
    recCategoryWeather: "Weather",
    recCategorySpeed: "Speed",
    recCategoryZoneAlert: "Zone Alert",
    recCategoryDistraction: "Distraction",
    recCategoryTrafficControl: "Traffic Control",
    recCategoryBraking: "Braking",
    recCategoryVehicle: "Vehicle",
    recCategoryDrivingStyle: "Driving Style",
    recCategoryAdvisory: "Advisory",
    contextualSpeed: "Contextual Speed",
    speedExposure: "Speed exposure",
    amplificationSuffix: "{label} amplification",
    ptsSuffix: "{value} pts",
    eventsSuffix24h: "{n} events · 24h",
    fieldProvider: "Provider",
    fieldDataStatus: "Data status",
    fieldLastEvent: "Last event",
    fieldEventTime: "Event time",
    fieldLastSync: "Last sync",
    fieldEvents24h: "Events (24h)",
    demoDisclosure:
      "This account uses simulated driving data for demonstration. Connected fleet drivers receive real telematics data.",
    andJoiner: "and",

    // ── Audit ───────────────────────────────────────────────────────────
    auditTrail: "Audit Trail",
    tabLog: "Log",
    tabReports: "Reports",
    failedLoadAudit: "Failed to load audit events.",
    noActivity: "No activity recorded yet.",
    openDashboardToTrack: "Open the dashboard to begin tracking.",
    showFewerEvents: "Show fewer events",
    viewMoreEvents: "View {n} more events",
    reportDailyTitle: "Daily Report",
    reportDailyDesc: "Safety summary for today",
    reportWeeklyTitle: "Weekly Summary",
    reportWeeklyDesc: "7-day performance overview",
    reportMonthlyTitle: "Monthly Analysis",
    reportMonthlyDesc: "30-day trends and insights",
    reportCustomTitle: "Custom Report",
    reportCustomDesc: "Define your own date range",
    fmcsaExportTitle: "FMCSA Compliance Export",
    fmcsaExportDesc: "Generate a regulatory-ready report for FMCSA submission or carrier review.",
    exportFmcsaReport: "Export FMCSA Report",

    // ── Inspect ─────────────────────────────────────────────────────────
    vehicleInspection: "Vehicle Inspection",
    aiPoweredPreTrip: "AI-powered pre-trip analysis",
    readyToScan: "Ready to scan",
    analyzingVehicle: "Analyzing vehicle...",
    startInspection: "Start Inspection",
    noRecentInspections: "No recent inspections",
    inspectInstructions:
      "Tap Start Inspection to photograph your vehicle. The AI will check tires, brakes, lights, windshield, and engine bay.",
    inspectionChecklist: "Inspection Checklist",
    aiSummary: "AI Summary",
    newInspection: "New Inspection",
    couldNotResolveDriver: "Could not resolve driver",
    inspectionFailed: "Inspection failed",
    overallPassed: "Passed",
    overallWarning: "Warning",
    overallFailed: "Failed",
    confidenceSuffix: "{pct}% confidence",

    // ── Settings ────────────────────────────────────────────────────────
    settingsTitle: "Settings",
    professionalDriver: "Professional Driver · SafeHaul",
    active: "Active",
    sectionAccount: "Account",
    driverProfile: "Driver Profile",
    view: "View",
    notifications: "Notifications",
    on: "On",
    preferences: "Preferences",
    sectionSystem: "System",
    connectedDevices: "Connected Devices",
    privacy: "Privacy",
    aboutSafeHaul: "About SafeHaul",
    logOut: "Log Out",
    footerVersion: "SafeHaul v0.2.0 · Operational Safety Platform",
    footerBuiltFor: "Built for professional drivers",
    language: "Language",

    // ── Legal gate ──────────────────────────────────────────────────────
    couldntLoadDocument: "Couldn't load that document. Please try again.",
    acceptanceFailed: "One or more documents failed to record acceptance",
    acceptanceError: "Something went wrong recording your acceptance. Please try again.",
    beforeYouContinue: "Before you continue",
    legalExplanation:
      "SafeHaul uses your driving and vehicle data to provide safety recommendations, risk scores, and inspection results. Please review and accept the documents below to continue.",
    viewDocPrefix: "View",
    loadingDoc: "Loading...",
    unableToLoadDoc: "Unable to load document.",
    agreeCheckboxLabel:
      "I have read and agree to the Terms of Use and acknowledge the Privacy Notice.",
    agreeContinue: "Agree & Continue",

    // ── Driving overlay ─────────────────────────────────────────────────
    voiceLabel: "VOICE",
    tapToSpeak: "TAP TO SPEAK · ICAO PROTOCOL",
    phraseologyPrompt: "PHRASEOLOGY PROMPT · STANDARDIZED",
    recIndicator: "REC",

    // ── Top bar ─────────────────────────────────────────────────────────
    gpsActive: "GPS Active",

    // ── Toasts ──────────────────────────────────────────────────────────
    toastDrivingOn: "Driving mode activated",
    toastDrivingOff: "Driving mode off",
    toastListening: "Listening...",
    toastPhraseCopied: "Phrase copied",
    toastIncidentSubmitted: "Incident report submitted",
    toastGeneratingReport: "Generating report...",
    toastLoadingEventDetails: "Loading event details...",
    toastLoggedOut: "Logged out",
  },
  ru: {
    // ── Navigation ──────────────────────────────────────────────────────
    navHeadsUp: "Панель",
    navInspect: "Осмотр",
    navAudit: "Аудит",
    navSettings: "Настройки",

    // ── Common ──────────────────────────────────────────────────────────
    cancel: "Отмена",

    // ── Dashboard / Heads-Up ────────────────────────────────────────────
    riskLow: "Низкий риск",
    riskMedium: "Средний риск",
    riskHigh: "Высокий риск",
    riskCritical: "Критический риск",
    statusFullyLive: "Все данные в реальном времени",
    statusPartiallyLive: "Частично в реальном времени",
    statusPublicDemo: "Публичная демо-версия",
    greetingMorning: "Доброе утро",
    greetingAfternoon: "Добрый день",
    greetingEvening: "Добрый вечер",
    driveSafelyToday: "Безопасной дороги сегодня.",
    realtimePredictiveRisk: "Прогноз риска в реальном времени",
    failedLoadRisk: "Не удалось загрузить данные о риске. Попробуйте снова.",
    primaryRiskFactors: "Основные факторы риска",
    liveInputsOf: "Данные в реальном времени: {count} из {total}",
    contextIncomplete: "Данные неполные: нет данных {list}.",
    initiateIncidentProtocol: "Запустить протокол происшествия",
    incidentDescription: "Описание происшествия",
    incidentPlaceholder: "Кратко опишите, что произошло...",
    submitting: "Отправка...",
    submitReport: "Отправить отчёт",
    todaysSummary: "Сводка за сегодня",
    checksPassed: "Проверок\nпройдено",
    milesDrivenLabel: "Миль\nпройдено",
    alertsActive: "Активных\nоповещений",
    recommendations: "Рекомендации",
    recCategoryFatigue: "Усталость",
    recCategoryWeather: "Погода",
    recCategorySpeed: "Скорость",
    recCategoryZoneAlert: "Зона риска",
    recCategoryDistraction: "Отвлечение внимания",
    recCategoryTrafficControl: "Дорожные знаки",
    recCategoryBraking: "Торможение",
    recCategoryVehicle: "Автомобиль",
    recCategoryDrivingStyle: "Стиль вождения",
    recCategoryAdvisory: "Рекомендация",
    contextualSpeed: "Контекстная скорость",
    speedExposure: "Скоростная нагрузка",
    amplificationSuffix: "Усиление ({label})",
    ptsSuffix: "{value} баллов",
    eventsSuffix24h: "{n} событий · 24ч",
    fieldProvider: "Провайдер",
    fieldDataStatus: "Статус данных",
    fieldLastEvent: "Последнее событие",
    fieldEventTime: "Время события",
    fieldLastSync: "Последняя синхронизация",
    fieldEvents24h: "События (24ч)",
    demoDisclosure:
      "Этот аккаунт использует смоделированные данные вождения для демонстрации. Подключённые водители получают реальные телематические данные.",
    andJoiner: "и",

    // ── Audit ───────────────────────────────────────────────────────────
    auditTrail: "Журнал аудита",
    tabLog: "Журнал",
    tabReports: "Отчёты",
    failedLoadAudit: "Не удалось загрузить события аудита.",
    noActivity: "Пока нет записанных событий.",
    openDashboardToTrack: "Откройте панель, чтобы начать отслеживание.",
    showFewerEvents: "Показать меньше событий",
    viewMoreEvents: "Показать ещё {n} событий",
    reportDailyTitle: "Дневной отчёт",
    reportDailyDesc: "Сводка безопасности за сегодня",
    reportWeeklyTitle: "Недельная сводка",
    reportWeeklyDesc: "Обзор за 7 дней",
    reportMonthlyTitle: "Месячный анализ",
    reportMonthlyDesc: "Тренды и аналитика за 30 дней",
    reportCustomTitle: "Свой отчёт",
    reportCustomDesc: "Задайте свой диапазон дат",
    fmcsaExportTitle: "Экспорт отчёта FMCSA",
    fmcsaExportDesc: "Сформируйте отчёт, готовый для подачи в FMCSA или проверки перевозчиком.",
    exportFmcsaReport: "Экспортировать отчёт FMCSA",

    // ── Inspect ─────────────────────────────────────────────────────────
    vehicleInspection: "Осмотр автомобиля",
    aiPoweredPreTrip: "Предрейсовый анализ на основе ИИ",
    readyToScan: "Готово к сканированию",
    analyzingVehicle: "Анализ автомобиля...",
    startInspection: "Начать осмотр",
    noRecentInspections: "Нет недавних осмотров",
    inspectInstructions:
      "Нажмите «Начать осмотр», чтобы сфотографировать автомобиль. ИИ проверит шины, тормоза, фары, лобовое стекло и моторный отсек.",
    inspectionChecklist: "Чек-лист осмотра",
    aiSummary: "Заключение ИИ",
    newInspection: "Новый осмотр",
    couldNotResolveDriver: "Не удалось определить водителя",
    inspectionFailed: "Осмотр не удался",
    overallPassed: "Пройдено",
    overallWarning: "Предупреждение",
    overallFailed: "Не пройдено",
    confidenceSuffix: "{pct}% уверенности",

    // ── Settings ────────────────────────────────────────────────────────
    settingsTitle: "Настройки",
    professionalDriver: "Профессиональный водитель · SafeHaul",
    active: "Активен",
    sectionAccount: "Аккаунт",
    driverProfile: "Профиль водителя",
    view: "Просмотр",
    notifications: "Уведомления",
    on: "Вкл",
    preferences: "Параметры",
    sectionSystem: "Система",
    connectedDevices: "Подключённые устройства",
    privacy: "Конфиденциальность",
    aboutSafeHaul: "О SafeHaul",
    logOut: "Выйти",
    footerVersion: "SafeHaul v0.2.0 · Платформа операционной безопасности",
    footerBuiltFor: "Создано для профессиональных водителей",
    language: "Язык",

    // ── Legal gate ──────────────────────────────────────────────────────
    couldntLoadDocument: "Не удалось загрузить документ. Попробуйте снова.",
    acceptanceFailed: "Не удалось зафиксировать согласие с одним или несколькими документами",
    acceptanceError: "Произошла ошибка при сохранении согласия. Попробуйте снова.",
    beforeYouContinue: "Прежде чем продолжить",
    legalExplanation:
      "SafeHaul использует данные о вашем вождении и автомобиле, чтобы предоставлять рекомендации по безопасности, оценки риска и результаты осмотра. Пожалуйста, ознакомьтесь и примите документы ниже, чтобы продолжить.",
    viewDocPrefix: "Просмотреть",
    loadingDoc: "Загрузка...",
    unableToLoadDoc: "Не удалось загрузить документ.",
    agreeCheckboxLabel:
      "Я прочитал(а) и согласен(на) с Условиями использования и уведомлением о конфиденциальности.",
    agreeContinue: "Принять и продолжить",

    // ── Driving overlay ─────────────────────────────────────────────────
    voiceLabel: "ГОЛОС",
    tapToSpeak: "НАЖМИТЕ, ЧТОБЫ ГОВОРИТЬ · ПРОТОКОЛ ICAO",
    phraseologyPrompt: "ПОДСКАЗКА ФРАЗЕОЛОГИИ · СТАНДАРТИЗИРОВАНО",
    recIndicator: "ЗАП",

    // ── Top bar ─────────────────────────────────────────────────────────
    gpsActive: "GPS активен",

    // ── Toasts ──────────────────────────────────────────────────────────
    toastDrivingOn: "Режим вождения включён",
    toastDrivingOff: "Режим вождения выключен",
    toastListening: "Слушаю...",
    toastPhraseCopied: "Фраза скопирована",
    toastIncidentSubmitted: "Отчёт о происшествии отправлен",
    toastGeneratingReport: "Формирование отчёта...",
    toastLoadingEventDetails: "Загрузка деталей события...",
    toastLoggedOut: "Вы вышли из аккаунта",
  },
} as const;

export type TranslationKey = keyof typeof translations.en;

/**
 * Looks up `key` in `language`'s dictionary, falling back to English for a
 * missing key and to the key itself (stringified) if even English somehow
 * lacks it — this function must never throw and never return `undefined`.
 * `vars` performs simple `{name}` placeholder substitution for the handful
 * of templated strings above (e.g. `liveInputsOf`, `viewMoreEvents`).
 */
export function translate(
  key: TranslationKey,
  language: Language,
  vars?: Record<string, string | number>
): string {
  const dict = translations[language] ?? translations.en;
  let str: string = dict[key] ?? translations.en[key] ?? String(key);
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      str = str.split(`{${name}}`).join(String(value));
    }
  }
  return str;
}
