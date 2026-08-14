// แถบคุกกี้หน้าแนะนำระบบ — ทำงานหลังเนื้อหาโหลดครบ ไม่กระทบการอ่านของ Search Engine
// แยกออกมาเป็นไฟล์ต่างหาก เพื่อให้ตั้ง Content-Security-Policy แบบเข้ม (script-src 'self') ได้
(function () {
  var KEY = 'fp_cookie_consent';
  var bar = document.getElementById('cookie');
  if (!bar) return;
  try { if (!localStorage.getItem(KEY)) bar.hidden = false; } catch { /* โหมดส่วนตัว */ }
  bar.addEventListener('click', function (e) {
    var choice = e.target.getAttribute('data-cookie');
    if (!choice) return;
    try { localStorage.setItem(KEY, choice); } catch { /* ไม่บันทึกก็ใช้งานได้ */ }
    bar.hidden = true;
  });
})();
