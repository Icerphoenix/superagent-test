// Aerobic calorie burn, from the workbook's 「16有氧热量消耗」 sheet.
// Two methods, both expressed as kcal per kg body weight per hour:
//  1. heart rate:   activeHR / restHR * 6.4 - 6.2
//  2. activity list (data/activities.json), rounded to 0.1 like the sheet.

export function hrMethod({ restHr, activeHr }) {
  const perKg = (activeHr / restHr) * 6.4 - 6.2;
  return perKg;
}

export function hrMethodKcal({ weightKg, restHr, activeHr, hours }) {
  const perKg = hrMethod({ restHr, activeHr });
  if (!(perKg > 0)) {
    return {
      kcal: 0,
      kcalPerKgHour: round(perKg, 3),
      valid: false,
      message: "按这个静息心率/运动心率算出来没有消耗，静息心率偏高时请改用运动项目法",
    };
  }
  return { kcal: Math.round(perKg * weightKg * hours), kcalPerKgHour: round(perKg, 3), valid: true };
}

export function activityKcal({ weightKg, kcalPerKgHour, hours }) {
  return Math.round(kcalPerKgHour * weightKg * hours);
}

export function round(x, digits = 1) {
  const p = 10 ** digits;
  return Math.round(x * p) / p;
}
