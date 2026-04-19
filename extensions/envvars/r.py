def to_bin(integer: int) -> str:
    res = []
    top = 0
    while 2 ** top <= integer:
        top += 1
    top -= 1

    
    while top >= 0:
        if 2 ** top <= integer:
            integer -= 2 ** top
            res.append("1")
        else:
            res.append("0")
        top -= 1

    return "".join(res)

def to_int(s: str) -> int:
    if s == '':
        return 0
    s = s.lstrip('0')
    res = 0
    for i, c in enumerate(s):
        if c == '1':
            res += 2 ** (len(s) - 1 - i)

    return res

print(to_int(to_bin(10)))
