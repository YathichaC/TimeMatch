async function loadNavbarUser() {
    // ตรวจสอบ User ที่กำลัง Login
    const {
        data: { user },
        error: userError
    } = await supabaseClient.auth.getUser();

    if (userError || !user) {
        console.log("Navbar: ยังไม่ได้เข้าสู่ระบบ");
        return;
    }

    // ดึงข้อมูล Profile
    const { data: profile, error: profileError } = await supabaseClient
        .from("profiles")
        .select("full_name")
        .eq("id", user.id)
        .single();

    if (profileError) {
        console.error("Navbar profile error:", profileError);
        return;
    }

    // แสดงชื่อบน Navbar
    const navbarUserName = document.getElementById("navbarUserName");

    if (navbarUserName) {
        navbarUserName.textContent = profile.full_name || "";
    }
}

loadNavbarUser();