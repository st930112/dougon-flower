import Bezier from 'bezier-js';
import MagneticCurve from '../model/MagneticCurve';
import CurveManagement from './CurveManagement';
import * as UI from '../model/UIManagement';


export default class LevelCurve {
	/**
		@param levelParam : array
		length : number
		alpha : number
		branches : number
	*/
	constructor(basePath, trunkWidth, levelParam){
		this.basePath = basePath;
		this.trunkWidth = trunkWidth;
		this.levelParam = levelParam;
		this.curveGroup = undefined;
	}
	drawLevelCurve(beziers, level){
		if( !beziers ) return;
		let sign = 1;

		let Bs = beziers.map(b =>{
			return new Bezier(
				b[0][0], b[0][1],
				b[1][0], b[1][1],
				b[2][0], b[2][1],
				b[3][0], b[3][1]
			);
		});

		let totalLength = Bs.reduce( (length, B) =>{
			return B.length() + length;
		}, 0);

		this.branchPosition(level).forEach((i) => {
			if( totalLength === 0) return;

			let bezierIndex = 0;

			let pos = totalLength * i;
			while( pos >= Bs[bezierIndex].length() ) {
				pos -= Bs[bezierIndex].length();
				bezierIndex++;
			}

			let posOnSinglebezier = pos / Bs[bezierIndex].length();

			this.drawAt(posOnSinglebezier, Bs[bezierIndex], sign, level);

			sign *= -1;
		});
	}
	drawAt(t, b, sign, level){
		let start = b.get(t);
		let v = b.derivative(t);
		let mag = new MagneticCurve({
			startX: start.x,
			startY: start.y,
			vx: v.x,
			vy: v.y,
			T: this.levelParam[level].length,
			alpha: this.levelParam[level].alpha,
			sign: sign
		});
		mag.drawOn(this.curveGroup);
		if (level < this.levelParam.length-1 ) this.drawLevelCurve(mag.points, level+1);
	}

	drawOn( pannel ){
		this.pannel = pannel;
		this.curveGroup = pannel.group();
		pannel.add(this.curveGroup);
		CurveManagement[this.curveGroup.node.id] = this;
		this.curveGroup.on('click', e => {
			console.log('clecked');

			let curve_id = e.target.parentElement.id;
			let lvCurve = CurveManagement[ curve_id ];
			CurveManagement.selectedCurve.length = 0;
			CurveManagement.selectedCurve.push(lvCurve);
		});

		this.drawLevelCurve(this.basePath, 0);
		this.drawStem();
	}
	drawStem(){
		
		let basePath = this.basePath.map(c =>{
			return new Bezier(
				c[0][0], c[0][1],
				c[1][0], c[1][1],
				c[2][0], c[2][1],
				c[3][0], c[3][1]
			);
		});
		

		let totalLength = basePath.reduce( (length, B) =>{
			return B.length() + length;
		}, 0);

		let l = 0;
		let w = UI.state.trunkWidth;

		let outline = basePath.map(b => {
			let d1 = w * l / totalLength;
			l += b.length();
			let d2 = w * l / totalLength;
			if(d1 === 0) d1 = 1;
			return b.outline(d1, d1, d2, d2);
		});
		outline.forEach(b => {
			let pathString = fittedCurveToPathString(b);
			drawOnPannel( this.curveGroup, pathString );
		});
		
	}
	redraw() {
		if( this.pannel === undefined ) {
			console.error('can not redraw!');
			return;
		}
		this.curveGroup.remove();
		this.drawOn(this.pannel);
	}

	branchPosition(level){
		let branches = [];
		let branch = this.levelParam[level].branches;

		let pos = 1 / (branch + 1);
		for (let i = 1; i <= branch; i++) {
			branches.push(pos * i);
		}

		return branches;
	}
}
function fittedCurveToPathString(fittedLineData) {
	var str = '';
	//bezier : [ [c0], [c1], [c2], [c3] ]
	fittedLineData.curves.map(function (bezier, i) {
		if (i == 0) {
			str += 'M ' + bezier.points[0].x + ' ' + bezier.points[0].y;
		}

		str += 'C ' + bezier.points[1].x + ' ' + bezier.points[1].y + ', ' +
		bezier.points[2].x + ' ' + bezier.points[2].y + ', ' +
		bezier.points[3].x + ' ' + bezier.points[3].y + ' ';	
					
	});

	return str;
}
function drawOnPannel(pannel, pathString){
	pannel.path( pathString ).fill('#bec9b3').stroke({ width: 0 });
}
