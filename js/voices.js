// Gemini の 作りおきの 声（30種）。性別・特徴は Google Cloud Gemini-TTS の 資料と 実際に 聞いた 印象。
export const VOICES = [
  {
    "name": "Zephyr",
    "gender": "female",
    "style": "明るい",
    "hint": "元気で聞き取りやすい女性。ナレーション・進行役に無難。"
  },
  {
    "name": "Puck",
    "gender": "male",
    "style": "元気・軽快",
    "hint": "軽快で若い男性。司会・ツッコミ・元気キャラ。"
  },
  {
    "name": "Charon",
    "gender": "male",
    "style": "落ち着いた説明口調",
    "hint": "低めで落ち着いた男性。上司・先生・ナレーター向き。"
  },
  {
    "name": "Kore",
    "gender": "female",
    "style": "しっかり・芯のある",
    "hint": "芯のある女性。リーダー・先輩・案内役。"
  },
  {
    "name": "Fenrir",
    "gender": "male",
    "style": "興奮・熱量高め",
    "hint": "テンション高めの男性。実況・盛り上げ役・少年。"
  },
  {
    "name": "Leda",
    "gender": "female",
    "style": "若々しい",
    "hint": "若い女性。学生・後輩・かわいい系。"
  },
  {
    "name": "Orus",
    "gender": "male",
    "style": "しっかり・低め安定",
    "hint": "低く安定した男性。社長・ベテラン・重厚な語り。"
  },
  {
    "name": "Aoede",
    "gender": "female",
    "style": "軽やか・爽やか",
    "hint": "爽やかな女性。明るい同僚・受付・案内。"
  },
  {
    "name": "Callirrhoe",
    "gender": "female",
    "style": "おっとり・のんびり",
    "hint": "のんびりした女性。癒やし系・やさしい先輩。"
  },
  {
    "name": "Autonoe",
    "gender": "female",
    "style": "明るい",
    "hint": "明るい女性。Zephyr の別バリエーション。"
  },
  {
    "name": "Enceladus",
    "gender": "male",
    "style": "息まじり・ささやき寄り",
    "hint": "息の多い男性。落ち着いた語り・内緒話・シリアス。"
  },
  {
    "name": "Iapetus",
    "gender": "male",
    "style": "クリア・聞き取りやすい",
    "hint": "はっきりした男性。説明・アナウンス。"
  },
  {
    "name": "Umbriel",
    "gender": "male",
    "style": "おっとり・のんびり",
    "hint": "のんびりした男性。おだやかな同僚・おじさん。"
  },
  {
    "name": "Algieba",
    "gender": "male",
    "style": "なめらか",
    "hint": "なめらかな男性。落ち着いたDJ・司会。"
  },
  {
    "name": "Despina",
    "gender": "female",
    "style": "なめらか",
    "hint": "なめらかな女性。上品・落ち着いた案内。"
  },
  {
    "name": "Erinome",
    "gender": "female",
    "style": "クリア",
    "hint": "はっきりした女性。ニュース・説明。"
  },
  {
    "name": "Algenib",
    "gender": "male",
    "style": "しゃがれ・ざらつき",
    "hint": "しゃがれ声の男性。強面・年配・渋いキャラ。"
  },
  {
    "name": "Rasalgethi",
    "gender": "male",
    "style": "説明口調",
    "hint": "説明向きの男性。Charon の別バリエーション。"
  },
  {
    "name": "Laomedeia",
    "gender": "female",
    "style": "元気・軽快",
    "hint": "元気な女性。盛り上げ役・司会。"
  },
  {
    "name": "Achernar",
    "gender": "female",
    "style": "やわらか",
    "hint": "やわらかい女性。やさしい語り・子ども向け。"
  },
  {
    "name": "Alnilam",
    "gender": "male",
    "style": "しっかり",
    "hint": "しっかりした男性。Orus の別バリエーション。"
  },
  {
    "name": "Schedar",
    "gender": "male",
    "style": "平坦・落ち着き",
    "hint": "平坦で落ち着いた男性。淡々とした説明。"
  },
  {
    "name": "Gacrux",
    "gender": "female",
    "style": "大人っぽい・成熟",
    "hint": "大人っぽい女性。年上・上司・母親役。"
  },
  {
    "name": "Pulcherrima",
    "gender": "female",
    "style": "前のめり・積極的",
    "hint": "積極的な女性。営業・司会・押しの強いキャラ。"
  },
  {
    "name": "Achird",
    "gender": "male",
    "style": "フレンドリー",
    "hint": "親しみやすい男性。同僚・友だち役。"
  },
  {
    "name": "Zubenelgenubi",
    "gender": "male",
    "style": "カジュアル",
    "hint": "カジュアルな男性。タメ口・くだけた会話。"
  },
  {
    "name": "Vindemiatrix",
    "gender": "female",
    "style": "おだやか・やさしい",
    "hint": "おだやかな女性。カウンセラー・やさしい先生。"
  },
  {
    "name": "Sadachbia",
    "gender": "male",
    "style": "生き生き",
    "hint": "生き生きした男性。子ども・元気キャラ。"
  },
  {
    "name": "Sadaltager",
    "gender": "male",
    "style": "知的・物知り",
    "hint": "知的な男性。専門家・博士・解説者。"
  },
  {
    "name": "Sulafat",
    "gender": "female",
    "style": "あたたかい",
    "hint": "あたたかい女性。ナレーション・包容力のある役。"
  }
];
