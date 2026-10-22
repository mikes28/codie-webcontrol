# title: Üdvözölés
# description: Sípol, megvilágítja a LED-eket és Morse-jel ketyeg — mozgás nélkül fut.

def run(ctx):
    """Hang és fény: a robot „megszólal"."""
    robot = ctx.robot

    ctx.log("LED zöldre")
    robot.led("green")
    ctx.wait(0.5)

    ctx.log("beep")
    robot.beep(300)
    ctx.wait(0.3)

    ctx.log("LED pirosra")
    robot.led("red")
    ctx.wait(0.3)

    ctx.log("Morse: CODIE")
    robot.morse("CODIE")
    ctx.wait(1.0)

    ctx.log("LED kikapcsolva")
    robot.leds_off()
