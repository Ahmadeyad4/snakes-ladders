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

## الأصدقاء والحسابات
- كل لاعب ياخذ رقم ثابت (6 أرقام) يظهر بالشاشة الرئيسية.
- السيرفر يحفظ الحسابات والأصدقاء بملف data.json (يمكن تغيير مكانه بمتغير البيئة DATA_FILE).
- على Render المجاني الملف يُمسح عند إعادة التشغيل أو النشر، فالأرقام والأصدقاء تضيع. للحفظ الدائم استخدم Persistent Disk أو قاعدة بيانات.
