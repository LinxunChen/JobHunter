// Shared calendar convention only; callers keep their own review, deadline and budget rules.
export const beijingDay = value => new Date(new Date(value).getTime()+8*3600000).toISOString().slice(0,10);
export const calendarDayDifference = (later,earlier) => Math.floor((Date.parse(later+'T00:00:00Z')-Date.parse(earlier+'T00:00:00Z'))/86400000);
