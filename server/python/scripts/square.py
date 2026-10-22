# title: Négyzetes kör
# description: Négy 20 cm-es oldal 90°-os fordulókkal — a robotnak szabadon kell forogni.

def run(ctx):
    """Egy négyzet körbejárása a robot API-jával."""
    robot = ctx.robot
    side_cm = 20

    ctx.log(f"négyzetes kör, oldal {side_cm} cm")
    for i in range(4):
        ctx.log(f"{i + 1}. oldal: előre {side_cm} cm")
        robot.forward(side_cm)
        ctx.log("fordulás 90° jobbra")
        robot.turn(90)
    ctx.log("kész")
