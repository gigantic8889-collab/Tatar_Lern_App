/* ============================================================
   parser.js — разбор подписок из свободного текста на русском.
   Работает и в браузере (window.SubParser), и в Node (require).
   Примеры:
     «иви через 30 дней»                      → Иви, через 30 дней
     «netflix 999 ₽ в месяц»                  → Netflix, ежемесячно, 999 ₽
     «кинопоиск до 15 декабря»                → дата 15.12
     «яндекс плюс ежемесячно, напомни за 3 дня» → ежемес., напомнить за 3 дня
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.SubParser = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- утилиты дат ---------- */
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function atNoon(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0); }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function addMonths(d, n) {
    const x = new Date(d);
    const day = x.getDate();
    x.setDate(1);
    x.setMonth(x.getMonth() + n);
    const last = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate();
    x.setDate(Math.min(day, last));
    return x;
  }
  function addYears(d, n) { const x = new Date(d); x.setFullYear(x.getFullYear() + n); return x; }

  function removeAt(s, i, len) {
    return s.slice(0, i) + ' '.repeat(len) + s.slice(i + len);
  }

  /* название месяца без захвата групп, чтобы безопасно встраивать в другие regexp */
  const MONTH_WORD = '(?:январ[а-я]*|феврал[а-я]*|март[а-я]*|мар[а-я]*|апрел[а-я]*|ма[а-я]{1,3}|июн[а-я]*|июл[а-я]*|август[а-я]*|сентябр[а-я]*|октябр[а-я]*|ноябр[а-я]*|декабр[а-я]*)';

  function monthIndex(word) {
    const w = String(word).toLowerCase().replace(/[^а-яё]/g, '');
    if (!w) return -1;
    const pairs = [
      ['январ', 0], ['феврал', 1], ['март', 2], ['мар', 2], ['апрел', 3],
      ['июн', 5], ['июл', 6], ['август', 7], ['сентябр', 8],
      ['октябр', 9], ['ноябр', 10], ['декабр', 11]
    ];
    for (let i = 0; i < pairs.length; i++) {
      if (w.indexOf(pairs[i][0]) === 0) return pairs[i][1];
    }
    // «май» и его формы проверяем строго, чтобы «магазин» не стал месяцем
    if (w === 'май' || w === 'мая' || w === 'мае' || w === 'маю' || w === 'маем' || w === 'маях' || w === 'маи') return 4;
    return -1;
  }

  /* ---------- основной парсер ---------- */
  function parseFreeText(input, now) {
    const result = {
      name: null, endDate: null, price: null, period: 'once',
      reminderDays: 2, found: false, parts: []
    };
    let text = String(input || '').trim();
    if (!text) return result;
    const base = now instanceof Date ? now : new Date();

    /* 1. Цена: 399₽, 399 руб, 399.90 р. */
    let m = text.match(/(\d{1,3}(?:\s?\d{3})*(?:[.,]\d{1,2})?)\s*(?:₽|рубл[а-я]*|руб\.?|р\.)/i);
    if (m) {
      const p = parseFloat(m[1].replace(/\s/g, '').replace(',', '.'));
      if (!isNaN(p) && p > 0) {
        result.price = Math.round(p * 100) / 100;
        text = removeAt(text, m.index, m[0].length);
        result.parts.push('цена');
      }
    }

    /* 2. Напоминание: «напомни за 3 дня» */
    m = text.match(/(?:напомни(?:ть)?\s*за\s*|за\s+)(\d{1,2})\s*(?:дня|дней|день|дн\.?)(?=$|[^а-яё])/i);
    if (m) {
      const d = parseInt(m[1], 10);
      if (d >= 1 && d <= 60) {
        result.reminderDays = d;
        text = removeAt(text, m.index, m[0].length);
        result.parts.push('напоминание');
      }
    }

    /* 3. Период: ежемесячно / ежегодно */
    if (/(ежегодн[а-я]*|кажд(?:ый|ую)\s+год|раз\s+в\s+год|в\s+год(?=$|[^а-яё]))/i.test(text)) {
      result.period = 'yearly';
      text = text.replace(/(ежегодн[а-я]*|кажд(?:ый|ую)\s+год|раз\s+в\s+год|в\s+год(?=$|[^а-яё]))/gi, ' ');
      result.parts.push('период');
    } else if (/(ежемесячн[а-я]*|кажд(?:ый|ую)\s+месяц|раз\s+в\s+месяц|в\s+месяц(?=$|[^а-яё])|месячн[а-я]*)/i.test(text)) {
      result.period = 'monthly';
      text = text.replace(/(ежемесячн[а-я]*|кажд(?:ый|ую)\s+месяц|раз\s+в\s+месяц|в\s+месяц(?=$|[^а-яё])|месячн[а-я]*)/gi, ' ');
      result.parts.push('период');
    }

    /* 4. Срок или дата окончания */
    let endDate = null;

    /* 4.1 «через N дней/недель/месяцев/лет» и «на N месяцев» */
    m = text.match(/через\s+(\d+(?:[.,]\d+)?)\s*(дн[а-я]*|день|недел[а-я]*|месяц[а-я]*|год[а-я]*|года|лет)(?=$|[^а-яё])/i);
    if (!m) m = text.match(/на\s+(\d+)\s*(недел[а-я]*|месяц[а-я]*|год[а-я]*|года|лет|дн[а-я]*)(?=$|[^а-яё])/i);
    if (!m) m = text.match(/за\s+(\d+)\s*(недел[а-я]*|месяц[а-я]*|год[а-я]*|года|лет)(?=$|[^а-яё])/i);
    if (m) {
      const n = parseFloat(m[1].replace(',', '.'));
      const unit = m[2].toLowerCase();
      if (/дн|день/.test(unit)) endDate = addDays(base, n);
      else if (/недел/.test(unit)) endDate = addDays(base, n * 7);
      else if (/месяц/.test(unit)) endDate = addMonths(base, n);
      else endDate = addYears(base, n);
      text = removeAt(text, m.index, m[0].length);
      result.parts.push('срок');
    }

    /* 4.2 «до 15 декабря [2026]» */
    if (!endDate) {
      m = text.match(new RegExp('(?:до|по)\\s+(\\d{1,2})\\s+(' + MONTH_WORD + ')(?:\\s*(\\d{4}))?', 'i'));
      if (m) {
        const day = parseInt(m[1], 10);
        const mi = monthIndex(m[2]);
        if (day >= 1 && day <= 31 && mi >= 0) {
          let y = m[3] ? parseInt(m[3], 10) : base.getFullYear();
          if (y < 100) y += 2000;
          if (y >= 2000 && y <= 2100) {
            let d = new Date(y, mi, day);
            if (d.getTime() < startOfDay(base).getTime()) d = new Date(y + 1, mi, day);
            endDate = d;
            text = removeAt(text, m.index, m[0].length);
            result.parts.push('дата');
          }
        }
      }
    }

    /* 4.3 «до 15.12», «до 15.12.2026» */
    if (!endDate) {
      m = text.match(/(?:до|по)\s+(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?/i);
      if (m) {
        const day = parseInt(m[1], 10);
        const mo = parseInt(m[2], 10) - 1;
        let y = m[3] ? parseInt(m[3], 10) : base.getFullYear();
        if (y < 100) y += 2000;
        if (day >= 1 && day <= 31 && mo >= 0 && mo <= 11) {
          let d = new Date(y, mo, day);
          if (d.getTime() < startOfDay(base).getTime()) d = new Date(y + 1, mo, day);
          endDate = d;
          text = removeAt(text, m.index, m[0].length);
          result.parts.push('дата');
        }
      }
    }

    /* 5. Имя — всё, что осталось */
    let name = text
      .replace(/^(?:подписка|подписку)\s+(?:на|к)?\s*/i, '')
      .replace(/^(?:добавь|добавить|добавь\s+подписку|запиши|записать|создай|напомни(?:ть)?\s+(?:мне\s+)?(?:о\s+|про\s+)?|оформи(?:ть)?\s*)/i, '')
      .replace(/(?:кончается|заканчивается|закончится|истекает|истечёт)\s*$/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[-–—\s,.;:!?«»"']+|[-–—\s,.;:!?«»"']+$/g, '')
      .trim();
    if (name) {
      result.name = name.charAt(0).toUpperCase() + name.slice(1);
    }

    /* 6. Если период задан, а даты нет — дата = один период */
    if (!endDate) {
      if (result.period === 'monthly') endDate = addMonths(base, 1);
      else if (result.period === 'yearly') endDate = addYears(base, 1);
    }

    if (endDate) result.endDate = atNoon(endDate).toISOString();
    result.found = !!(result.name && result.endDate);
    return result;
  }

  /* ---------- подсказка эмодзи по названию ---------- */
  function autoEmoji(name) {
    const rules = [
      [/кино|фильм|иви|ivi|окко|okkо|кинопоиск|netflix|premier|more\.tv|start\b|wink|amedia/i, '🎬'],
      [/музык|spotify|звук|zvuk|apple music|soundcloud|youtube music|яндекс музыка/i, '🎵'],
      [/книг|литрес|mybook|storytel|библиотек/i, '📚'],
      [/игр|playstation|ps plus|xbox|game pass|steam|nintendo|боевой пропуск/i, '🎮'],
      [/спорт|фитнес|тренир|sport|зал\b/i, '🏋️'],
      [/обучени|курс|школ|skillbox|нетологи|geekbrains|english|инглиш|универ/i, '🎓'],
      [/почт|диск|облак|хранилищ|dropbox|icloud|google one|onedrive|яндекс 360/i, '☁️'],
      [/vpn|впн/i, '🛡️'],
      [/доставк|еда|самокат|лавка|лайм|самокат/i, '🛒'],
      [/плюс|яндекс/i, '📦'],
      [/телефон|связ|мтс|билайн|мегафон|теле2|тариф|интернет|сим/i, '📱'],
      [/ai|нейро|gpt|claude|midjourney|copilot|gemini/i, '🤖'],
      [/почта|газет|новост|журнал/i, '📰'],
    ];
    for (let i = 0; i < rules.length; i++) {
      if (rules[i][0].test(name)) return rules[i][1];
    }
    return '🔔';
  }

  return {
    parseFreeText: parseFreeText,
    addDays: addDays,
    addMonths: addMonths,
    addYears: addYears,
    startOfDay: startOfDay,
    atNoon: atNoon,
    monthIndex: monthIndex,
    autoEmoji: autoEmoji
  };
});
