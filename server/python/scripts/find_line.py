# title: Vonalkereső
# description: Halad, amíg a vonalérzékelő jelet ad; a vonal elvesztésekor megáll és visszafelé keres.

def run(ctx):
    """A vonal megtartása — az irányjelzés nélkül csak keresni tudunk."""
    robot = ctx.robot
    step_cm = 5
    attempts = 8

    ctx.log("vonalkereső indítása")
    for i in range(attempts):
        line = robot.line()
        on_line = bool(line.get("onLine")) if isinstance(line, dict) else False
        level = line.get("level") if isinstance(line, dict) else None
        ctx.log(f"{i + 1}. lépés — vonalszint {level} ({'rajta' if on_line else 'nincs'})")
        if on_line:
            robot.forward(step_cm)
            ctx.wait(0.2)
            continue
        ctx.log("nincs vonal — megállok és visszafelé keresek")
        robot.backward(step_cm)
        ctx.wait(0.3)
    ctx.log("keresés vége")
