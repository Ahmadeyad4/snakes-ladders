# حية ودرج أونلاين

## 1) تشغيل السيرفر (لازم يكون أونلاين)
ارفع المجلد كله على GitHub، ثم على Render.com:
New > Web Service > اختر المستودع
- Build Command: npm install
- Start Command: npm start
بعد النشر يعطيك رابط مثل https://xxxx.onrender.com . افتحه بالمتصفح للتجربة.

## 2) صنع ملف APK
- عدّل الملف apk/capacitor.config.json وضع رابط السيرفر مكان CHANGE-ME.
- من GitHub: تبويب Actions > Build APK > Run workflow.
- بعد ما ينتهي (5-10 دقايق) نزّل snakes-ladders-apk من آخر تشغيل، فك الضغط وثبّت app-debug.apk.

## الأصدقاء والحسابات (حفظ دائم)
- كل لاعب ياخذ رقم ثابت (6 أرقام) يظهر بالشاشة الرئيسية.
- لحفظ الحسابات والأصدقاء بعد كل تحديث: سوّي قاعدة Upstash Redis مجانية (بدون بطاقة)،
  وأضف بـ Render > Environment متغيرين:
  - UPSTASH_REDIS_REST_URL
  - UPSTASH_REDIS_REST_TOKEN
- بدون المتغيرين تُحفظ البيانات بملف محلي يُمسح على Render المجاني عند كل نشر.
- بسجلات Render لازم يظهر سطر: Storage: Upstash Redis
